import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  Dialog,
  ICommandPalette,
  InputDialog,
  showDialog,
  ToolbarButton
} from '@jupyterlab/apputils';
import { ILauncher } from '@jupyterlab/launcher';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { YNotebook } from '@jupyter/ydoc';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { Awareness } from 'y-protocols/awareness';
import { Widget } from '@lumino/widgets';

const PLUGIN_ID = '@csis110/jupyterlab-pairing:plugin';
const JOIN_COMMAND_ID = '@csis110/jupyterlab-pairing:join-pairing';
const ROOM_CODE_PATTERN = /^[A-HJ-KM-NP-Z2-9]{5}-?[A-HJ-KM-NP-Z2-9]{5}$/;
const PRESENCE_CATEGORY = 'Notebook Pairing';
// Distinct, readable hues; partners are assigned one deterministically by client ID.
const PARTNER_COLORS = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#46f0f0'
];

interface RoomResponse {
  code: string;
  expiresAt: number;
  error?: string;
}

interface PairingSession {
  code: string;
  provider: HocuspocusProvider;
}

interface PresenceLocation {
  id: string;
  index: number;
}

interface PresenceAwarenessState {
  user?: { name: string; color: string };
  active?: PresenceLocation | null;
  visible?: PresenceLocation | null;
}

interface PartnerRecord {
  color: string;
  active: PresenceLocation | null;
  visible: PresenceLocation | null;
  lastActiveAt: number;
}

interface PresenceCallbacks {
  onPartnersChanged: (partners: Map<number, PartnerRecord>) => void;
}

function normalizeServiceUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function websocketUrl(serviceUrl: string, code: string): string {
  const url = new URL(`${serviceUrl}/api/rooms/${code}/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

async function roomRequest(url: string, method = 'POST'): Promise<RoomResponse> {
  const response = await fetch(url, { method });
  const payload = (await response.json()) as RoomResponse;
  if (!response.ok) {
    throw new Error(payload.error || `Pairing service returned ${response.status}.`);
  }
  return payload;
}

async function reportError(error: unknown): Promise<void> {
  await showDialog({
    title: 'Notebook pairing failed',
    body: error instanceof Error ? error.message : String(error),
    buttons: [Dialog.okButton()]
  });
}

function colorForClient(clientId: number): string {
  return PARTNER_COLORS[Math.abs(clientId) % PARTNER_COLORS.length];
}

/** A plain button toolbar item whose label/enabled state can be updated directly. */
class ActionButton extends Widget {
  constructor(options: { label: string; tooltip: string; onClick: () => void }) {
    const button = document.createElement('button');
    button.className = 'jp-ToolbarButtonComponent csis110-PairingButton';
    button.textContent = options.label;
    button.title = options.tooltip;
    button.onclick = options.onClick;
    super({ node: button });
    this.addClass('jp-ToolbarButton');
  }

  get buttonNode(): HTMLButtonElement {
    return this.node as HTMLButtonElement;
  }

  setLabel(label: string): void {
    this.buttonNode.textContent = label;
  }

  setEnabled(enabled: boolean): void {
    this.buttonNode.disabled = !enabled;
  }
}

function markerStyle(cellNode: HTMLElement, color: string | null, strong: boolean): void {
  if (!color) {
    cellNode.style.removeProperty('border-left');
    cellNode.style.removeProperty('background-color');
    return;
  }
  if (strong) {
    cellNode.style.borderLeft = `4px solid ${color}`;
    cellNode.style.removeProperty('background-color');
  } else {
    cellNode.style.removeProperty('border-left');
    cellNode.style.backgroundColor = `${color}22`;
  }
}

/**
 * Wires a notebook panel's Yjs Awareness state to broadcast this user's active/visible
 * cell and render markers for every other connected participant ("partner").
 */
function createPresence(panel: NotebookPanel, callbacks: PresenceCallbacks): () => void {
  const sharedModel = panel.context.model.sharedModel as YNotebook;
  const awareness: Awareness = sharedModel.awareness;
  const localColor = colorForClient(awareness.clientID);
  awareness.setLocalStateField('user', {
    name: `Guest ${awareness.clientID % 1000}`,
    color: localColor
  });

  const partners = new Map<number, PartnerRecord>();
  // Cells currently marked, so they can be cleared before the next render pass.
  const markedActive = new Map<number, number>();
  const markedVisible = new Map<number, number>();

  const locationOf = (index: number): PresenceLocation | null => {
    const cell = panel.content.widgets[index];
    return cell ? { id: cell.model.id, index } : null;
  };

  const broadcastActive = (): void => {
    const index = panel.content.activeCellIndex;
    awareness.setLocalStateField('active', index >= 0 ? locationOf(index) : null);
  };

  const broadcastVisible = (): void => {
    const scroller = panel.content.node;
    const scrollerTop = scroller.getBoundingClientRect().top;
    for (const widget of panel.content.widgets) {
      const rect = widget.node.getBoundingClientRect();
      if (rect.height === 0) {
        continue;
      }
      if (rect.bottom > scrollerTop) {
        const index = panel.content.widgets.indexOf(widget);
        awareness.setLocalStateField('visible', locationOf(index));
        return;
      }
    }
    awareness.setLocalStateField('visible', null);
  };

  let scrollFrame: number | null = null;
  const onScroll = (): void => {
    if (scrollFrame !== null) {
      return;
    }
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      broadcastVisible();
    });
  };

  const render = (): void => {
    for (const [clientId, previousIndex] of markedActive) {
      if (partners.get(clientId)?.active?.index !== previousIndex) {
        const node = panel.content.widgets[previousIndex]?.node;
        node && markerStyle(node, null, true);
      }
    }
    for (const [clientId, previousIndex] of markedVisible) {
      if (partners.get(clientId)?.visible?.index !== previousIndex) {
        const node = panel.content.widgets[previousIndex]?.node;
        node && markerStyle(node, null, false);
      }
    }
    markedActive.clear();
    markedVisible.clear();

    for (const [clientId, partner] of partners) {
      if (partner.active) {
        const node = panel.content.widgets[partner.active.index]?.node;
        if (node) {
          markerStyle(node, partner.color, true);
          markedActive.set(clientId, partner.active.index);
        }
      }
      if (partner.visible && partner.visible.index !== partner.active?.index) {
        const node = panel.content.widgets[partner.visible.index]?.node;
        if (node) {
          markerStyle(node, partner.color, false);
          markedVisible.set(clientId, partner.visible.index);
        }
      }
    }

    callbacks.onPartnersChanged(partners);
  };

  const onAwarenessChange = ({
    added,
    updated,
    removed
  }: {
    added: number[];
    updated: number[];
    removed: number[];
  }): void => {
    for (const clientId of removed) {
      const partner = partners.get(clientId);
      if (partner?.active) {
        const node = panel.content.widgets[partner.active.index]?.node;
        node && markerStyle(node, null, true);
      }
      if (partner?.visible) {
        const node = panel.content.widgets[partner.visible.index]?.node;
        node && markerStyle(node, null, false);
      }
      partners.delete(clientId);
    }

    for (const clientId of [...added, ...updated]) {
      if (clientId === awareness.clientID) {
        continue;
      }
      const state = awareness.getStates().get(clientId) as PresenceAwarenessState | undefined;
      if (!state) {
        continue;
      }
      const previous = partners.get(clientId);
      const activeChanged =
        JSON.stringify(previous?.active ?? null) !== JSON.stringify(state.active ?? null);
      partners.set(clientId, {
        color: colorForClient(clientId),
        active: state.active ?? null,
        visible: state.visible ?? null,
        lastActiveAt: activeChanged ? Date.now() : previous?.lastActiveAt ?? Date.now()
      });
    }

    render();
  };

  panel.content.activeCellChanged.connect(broadcastActive);
  panel.content.node.addEventListener('scroll', onScroll, true);
  awareness.on('change', onAwarenessChange);

  broadcastActive();
  broadcastVisible();

  return () => {
    panel.content.activeCellChanged.disconnect(broadcastActive);
    panel.content.node.removeEventListener('scroll', onScroll, true);
    awareness.off('change', onAwarenessChange);
    if (scrollFrame !== null) {
      cancelAnimationFrame(scrollFrame);
    }
    for (const index of markedActive.values()) {
      const node = panel.content.widgets[index]?.node;
      node && markerStyle(node, null, true);
    }
    for (const index of markedVisible.values()) {
      const node = panel.content.widgets[index]?.node;
      node && markerStyle(node, null, false);
    }
  };
}

/** The partner whose active cell changed most recently, used for the indicator and "follow". */
function mostRecentPartner(partners: Map<number, PartnerRecord>): PartnerRecord | null {
  let latest: PartnerRecord | null = null;
  for (const partner of partners.values()) {
    if (partner.active && (!latest || partner.lastActiveAt > latest.lastActiveAt)) {
      latest = partner;
    }
  }
  return latest;
}

function partnerIndicatorLabel(partners: Map<number, PartnerRecord>): string {
  const located = [...partners.values()]
    .filter(partner => partner.active)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  if (!located.length) {
    return 'Partner: —';
  }
  if (located.length === 1) {
    return `Partner: Cell ${located[0].active!.index + 1}`;
  }
  return `Partners: ${located.map(partner => `Cell ${partner.active!.index + 1}`).join(', ')}`;
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  autoStart: true,
  requires: [INotebookTracker, ISettingRegistry],
  optional: [ILauncher, ICommandPalette],
  activate: async (
    app: JupyterFrontEnd,
    notebooks: INotebookTracker,
    settingRegistry: ISettingRegistry,
    launcher: ILauncher | null,
    palette: ICommandPalette | null
  ): Promise<void> => {
    const settings = await settingRegistry.load(PLUGIN_ID);
    let serviceUrl = normalizeServiceUrl(
      String(settings.get('serviceUrl').composite)
    );
    const sessions = new Map<NotebookPanel, PairingSession>();

    settings.changed.connect(() => {
      serviceUrl = normalizeServiceUrl(
        String(settings.get('serviceUrl').composite)
      );
    });

    const disconnect = (panel: NotebookPanel): void => {
      const session = sessions.get(panel);
      session?.provider.destroy();
      sessions.delete(panel);
    };

    const connect = (
      panel: NotebookPanel,
      code: string,
      sharedModel: YNotebook
    ): PairingSession => {
      disconnect(panel);
      const normalizedCode = code.replace('-', '').toUpperCase();
      const provider = new HocuspocusProvider({
        url: websocketUrl(serviceUrl, normalizedCode),
        name: normalizedCode,
        document: sharedModel.ydoc,
        awareness: sharedModel.awareness
      });
      const session = { code, provider };
      sessions.set(panel, session);
      return session;
    };

    const startPairing = async (panel: NotebookPanel): Promise<void> => {
      try {
        const room = await roomRequest(`${serviceUrl}/api/rooms`);
        const sharedModel = panel.context.model.sharedModel as YNotebook;
        connect(panel, room.code, sharedModel);
        await showDialog({
          title: 'Pairing started',
          body: `Pairing code: ${room.code}\n\nThis room expires at ${new Date(
            room.expiresAt
          ).toLocaleString()}.`,
          buttons: [Dialog.okButton({ label: 'Close' })]
        });
      } catch (error) {
        await reportError(error);
      }
    };

    const joinPairing = async (
      panel: NotebookPanel,
      options: { skipConfirmation?: boolean } = {}
    ): Promise<void> => {
      const input = await InputDialog.getText({
        title: 'Join notebook pairing',
        label: 'Pairing code',
        placeholder: 'ABCDE-23456'
      });
      if (!input.button.accept || !input.value) {
        return;
      }

      const code = input.value.trim().toUpperCase();
      if (!ROOM_CODE_PATTERN.test(code)) {
        await reportError(new Error('Enter a valid ten-character pairing code.'));
        return;
      }

      if (!options.skipConfirmation) {
        const confirmation = await showDialog({
          title: 'Replace this notebook?',
          body: 'Joining loads the creator’s shared notebook and discards the current notebook contents. Open a new notebook first if you need to preserve this copy.',
          buttons: [
            Dialog.cancelButton(),
            Dialog.warnButton({ label: 'Replace and join' })
          ]
        });
        if (!confirmation.button.accept) {
          return;
        }
      }

      try {
        const room = await roomRequest(
          `${serviceUrl}/api/rooms/${code}/join`
        );
        const sharedModel = panel.context.model.sharedModel as YNotebook;
        sharedModel.transact(() => {
          if (sharedModel.cells.length) {
            sharedModel.deleteCellRange(0, sharedModel.cells.length);
          }
          sharedModel.setMetadata({});
        });
        connect(panel, room.code, sharedModel);
      } catch (error) {
        await reportError(error);
      }
    };

    app.commands.addCommand(JOIN_COMMAND_ID, {
      label: 'Join Notebook Pairing',
      caption: 'Create a new notebook and join a shared pairing session',
      execute: async () => {
        try {
          const widget = await app.commands.execute('notebook:create-new');
          if (!(widget instanceof NotebookPanel)) {
            throw new Error('Could not create a new notebook to join into.');
          }
          await widget.context.ready;
          await joinPairing(widget, { skipConfirmation: true });
        } catch (error) {
          await reportError(error);
        }
      }
    });
    if (launcher) {
      launcher.add({ command: JOIN_COMMAND_ID, category: PRESENCE_CATEGORY, rank: 0 });
    }
    if (palette) {
      palette.addItem({ command: JOIN_COMMAND_ID, category: PRESENCE_CATEGORY });
    }

    notebooks.widgetAdded.connect((_tracker, panel) => {
      const startButton = new ToolbarButton({
        className: 'csis110-PairingButton',
        label: 'Start pairing',
        onClick: () => void startPairing(panel),
        tooltip: 'Create a code for a shared notebook session'
      });

      let following = false;
      let partners = new Map<number, PartnerRecord>();
      let lastFollowedIndex: number | null = null;

      const indicatorButton = new ActionButton({
        label: 'Partner: —',
        tooltip: 'Scroll to the most recently active partner',
        onClick: () => {
          const partner = mostRecentPartner(partners);
          if (partner?.active) {
            void panel.content.scrollToItem(partner.active.index, 'smart');
          }
        }
      });
      const followButton = new ActionButton({
        label: 'Follow: Off',
        tooltip: "Automatically scroll to the partner's active cell",
        onClick: () => {
          following = !following;
          followButton.setLabel(following ? 'Follow: On' : 'Follow: Off');
        }
      });
      followButton.setEnabled(false);

      panel.toolbar.insertItem(10, 'csis110-start-pairing', startButton);
      panel.toolbar.insertItem(11, 'csis110-partner-indicator', indicatorButton);
      panel.toolbar.insertItem(12, 'csis110-follow-toggle', followButton);

      const disposePresence = createPresence(panel, {
        onPartnersChanged: updated => {
          partners = updated;
          indicatorButton.setLabel(partnerIndicatorLabel(partners));
          followButton.setEnabled(partners.size > 0);
          if (!partners.size) {
            following = false;
            followButton.setLabel('Follow: Off');
            lastFollowedIndex = null;
            return;
          }
          const activeIndex = mostRecentPartner(partners)?.active?.index ?? null;
          if (activeIndex === null) {
            lastFollowedIndex = null;
          } else if (following && activeIndex !== lastFollowedIndex) {
            lastFollowedIndex = activeIndex;
            void panel.content.scrollToItem(activeIndex, 'smart');
          }
        }
      });

      panel.disposed.connect(() => {
        disconnect(panel);
        disposePresence();
        startButton.dispose();
        indicatorButton.dispose();
        followButton.dispose();
      });
    });
  }
};

export default plugin;


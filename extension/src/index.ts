import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  Dialog,
  InputDialog,
  showDialog,
  ToolbarButton
} from '@jupyterlab/apputils';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { YNotebook } from '@jupyter/ydoc';
import { HocuspocusProvider } from '@hocuspocus/provider';

const PLUGIN_ID = '@csis110/jupyterlab-pairing:plugin';
const ROOM_CODE_PATTERN = /^[A-HJ-KM-NP-Z2-9]{5}-?[A-HJ-KM-NP-Z2-9]{5}$/;

interface RoomResponse {
  code: string;
  expiresAt: number;
  error?: string;
}

interface PairingSession {
  code: string;
  provider: HocuspocusProvider;
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

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  autoStart: true,
  requires: [INotebookTracker, ISettingRegistry],
  activate: async (
    app: JupyterFrontEnd,
    notebooks: INotebookTracker,
    settingRegistry: ISettingRegistry
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

    const joinPairing = async (panel: NotebookPanel): Promise<void> => {
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

    notebooks.widgetAdded.connect((_tracker, panel) => {
      const startButton = new ToolbarButton({
        className: 'csis110-PairingButton',
        label: 'Start pairing',
        onClick: () => void startPairing(panel),
        tooltip: 'Create a code for a shared notebook session'
      });
      const joinButton = new ToolbarButton({
        className: 'csis110-PairingButton',
        label: 'Join pairing',
        onClick: () => void joinPairing(panel),
        tooltip: 'Join a shared notebook session with a code'
      });

      panel.toolbar.insertItem(10, 'csis110-start-pairing', startButton);
      panel.toolbar.insertItem(11, 'csis110-join-pairing', joinButton);
      panel.disposed.connect(() => {
        disconnect(panel);
        startButton.dispose();
        joinButton.dispose();
      });
    });
  }
};

export default plugin;


import { Widget } from '@lumino/widgets';
import { Signal } from '@lumino/signaling';
import { NotebookPanel } from '@jupyterlab/notebook';
import type { PairingSnapshot, PairingStore } from './store';

/** Formats a duration as a coarse countdown; exact seconds are noise at this scale. */
function formatRemaining(expiresAt: number): string {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    return 'expired';
  }
  const minutes = Math.floor(remaining / 60000);
  if (minutes < 1) {
    return 'under a minute';
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hr ${minutes % 60} min`;
  }
  return `${Math.floor(hours / 24)} d ${hours % 24} hr`;
}

export interface PairingPanelOptions {
  store: PairingStore;
  onStart: (panel: NotebookPanel) => void;
  onJoin: (panel: NotebookPanel) => void;
  onStop: (panel: NotebookPanel) => void;
}

/**
 * Right-hand panel showing the active notebook's pairing state.
 *
 * The pairing code used to appear only in a dialog at creation time, which made
 * it unrecoverable once dismissed and left joiners unable to invite anyone else.
 * Keeping it on screen here is the point of the panel.
 */
export class PairingPanel extends Widget {
  private readonly options: PairingPanelOptions;
  private panel: NotebookPanel | null = null;
  private countdownTimer: number | null = null;
  private copyResetTimer: number | null = null;

  private readonly statusNode = document.createElement('p');
  private readonly codeNode = document.createElement('div');
  private readonly copyButton = document.createElement('button');
  private readonly expiryNode = document.createElement('p');
  private readonly partnersNode = document.createElement('ul');
  private readonly startButton = document.createElement('button');
  private readonly joinButton = document.createElement('button');
  private readonly stopButton = document.createElement('button');
  private readonly adminLink = document.createElement('a');

  constructor(options: PairingPanelOptions) {
    super();
    this.options = options;
    this.addClass('csis110-PairingPanel');
    this.buildDom();

    options.store.changed.connect(this.onStoreChanged, this);
    this.countdownTimer = window.setInterval(() => this.renderExpiry(), 30000);
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.options.store.changed.disconnect(this.onStoreChanged, this);
    if (this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
    }
    if (this.copyResetTimer !== null) {
      window.clearTimeout(this.copyResetTimer);
    }
    Signal.clearData(this);
    super.dispose();
  }

  /** Points the panel at a notebook, or at nothing when no notebook is focused. */
  setPanel(panel: NotebookPanel | null): void {
    this.panel = panel;
    this.render();
  }

  /**
   * Shows or hides the shortcut to the admin dashboard.
   *
   * Hidden unless someone opts in, because this panel is on screen for every
   * student and the dashboard is only reachable by whoever Access lets in.
   */
  setAdminUrl(url: string | null): void {
    if (url) {
      this.adminLink.href = url;
    } else {
      this.adminLink.removeAttribute('href');
    }
    this.adminLink.hidden = !url;
  }

  private onStoreChanged(_store: PairingStore, changed: NotebookPanel): void {
    if (changed === this.panel) {
      this.render();
    }
  }

  private buildDom(): void {
    const root = document.createElement('div');
    root.className = 'csis110-PairingPanel-body';

    const heading = document.createElement('h2');
    heading.textContent = 'Notebook Pairing';
    root.appendChild(heading);

    this.statusNode.className = 'csis110-PairingPanel-status';
    root.appendChild(this.statusNode);

    this.codeNode.className = 'csis110-PairingPanel-code';
    root.appendChild(this.codeNode);

    this.copyButton.textContent = 'Copy code';
    this.copyButton.className = 'jp-mod-styled';
    this.copyButton.addEventListener('click', () => void this.copyCode());
    root.appendChild(this.copyButton);

    this.expiryNode.className = 'csis110-PairingPanel-expiry';
    root.appendChild(this.expiryNode);

    const partnersHeading = document.createElement('h3');
    partnersHeading.textContent = 'In this session';
    root.appendChild(partnersHeading);
    this.partnersNode.className = 'csis110-PairingPanel-partners';
    root.appendChild(this.partnersNode);

    const actions = document.createElement('div');
    actions.className = 'csis110-PairingPanel-actions';
    for (const [button, label, handler] of [
      [this.startButton, 'Start pairing', this.options.onStart],
      [this.joinButton, 'Join pairing', this.options.onJoin],
      [this.stopButton, 'Stop pairing', this.options.onStop]
    ] as const) {
      button.textContent = label;
      button.className = 'jp-mod-styled';
      button.addEventListener('click', () => {
        if (this.panel) {
          handler(this.panel);
        }
      });
      actions.appendChild(button);
    }
    root.appendChild(actions);

    // A new tab, not a navigation: leaving the page would tear down the
    // JupyterLite session, and the dashboard may bounce through an Access
    // login on the way.
    this.adminLink.className = 'csis110-PairingPanel-admin';
    this.adminLink.target = '_blank';
    this.adminLink.rel = 'noopener noreferrer';
    this.adminLink.textContent = 'Admin dashboard ↗';
    this.adminLink.hidden = true;
    root.appendChild(this.adminLink);

    this.node.appendChild(root);
  }

  private async copyCode(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot?.session) {
      return;
    }
    const code = snapshot.session.code;
    try {
      await navigator.clipboard.writeText(code);
      this.copyButton.textContent = 'Copied';
    } catch {
      // Clipboard access can be refused; the code stays visible either way.
      this.copyButton.textContent = 'Press Ctrl+C to copy';
    }
    if (this.copyResetTimer !== null) {
      window.clearTimeout(this.copyResetTimer);
    }
    this.copyResetTimer = window.setTimeout(() => {
      this.copyButton.textContent = 'Copy code';
    }, 2000);
  }

  /** A notebook can be closed while still targeted here, so treat it as gone. */
  private activePanel(): NotebookPanel | null {
    return this.panel && !this.panel.isDisposed ? this.panel : null;
  }

  private snapshot(): PairingSnapshot | null {
    const panel = this.activePanel();
    return panel ? this.options.store.get(panel) : null;
  }

  private render(): void {
    const snapshot = this.snapshot();
    const session = snapshot?.session ?? null;
    const panel = this.activePanel();

    if (!panel) {
      this.statusNode.textContent = 'Open a notebook to start or join a pairing session.';
    } else if (session) {
      this.statusNode.textContent = 'Pairing is active. Share this code to invite someone.';
    } else {
      this.statusNode.textContent = 'This notebook is not paired.';
    }

    this.codeNode.textContent = session?.code ?? '';
    this.codeNode.hidden = !session;
    this.copyButton.hidden = !session;

    this.startButton.disabled = !panel || Boolean(session);
    this.joinButton.disabled = !panel || Boolean(session);
    this.stopButton.disabled = !session;

    this.renderExpiry();
    this.renderPartners(snapshot);
  }

  private renderExpiry(): void {
    const session = this.snapshot()?.session ?? null;
    if (!session) {
      this.expiryNode.textContent = '';
      this.expiryNode.hidden = true;
      return;
    }
    this.expiryNode.hidden = false;
    this.expiryNode.textContent =
      session.expiresAt === null
        ? ''
        : `Expires in ${formatRemaining(session.expiresAt)}.`;
  }

  private renderPartners(snapshot: PairingSnapshot | null): void {
    this.partnersNode.textContent = '';
    const partners = snapshot?.partners;

    if (!snapshot?.session) {
      const item = document.createElement('li');
      item.textContent = 'Not paired.';
      item.className = 'csis110-PairingPanel-muted';
      this.partnersNode.appendChild(item);
      return;
    }

    if (!partners || partners.size === 0) {
      const item = document.createElement('li');
      item.textContent = 'Waiting for someone to join…';
      item.className = 'csis110-PairingPanel-muted';
      this.partnersNode.appendChild(item);
      return;
    }

    for (const partner of partners.values()) {
      const item = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'csis110-PairingPanel-swatch';
      swatch.style.backgroundColor = partner.color;
      item.appendChild(swatch);
      item.appendChild(
        document.createTextNode(
          partner.active ? `Cell ${partner.active.index + 1}` : 'Elsewhere'
        )
      );
      this.partnersNode.appendChild(item);
    }
  }
}

import { Signal } from '@lumino/signaling';
import { NotebookPanel } from '@jupyterlab/notebook';
import type { HocuspocusProvider } from '@hocuspocus/provider';

export interface PresenceLocation {
  id: string;
  index: number;
}

export interface PartnerRecord {
  color: string;
  active: PresenceLocation | null;
  visible: PresenceLocation | null;
  lastActiveAt: number;
}

export interface PairingSession {
  code: string;
  expiresAt: number | null;
  provider: HocuspocusProvider;
}

export interface PairingSnapshot {
  session: PairingSession | null;
  partners: Map<number, PartnerRecord>;
}

/**
 * Per-notebook pairing state, shared by the toolbar and the sidebar panel.
 *
 * Both surfaces need the same facts and must not disagree, so they read one
 * store and re-render from its signal rather than tracking state separately.
 */
export class PairingStore {
  readonly changed = new Signal<PairingStore, NotebookPanel>(this);

  private readonly entries = new Map<NotebookPanel, PairingSnapshot>();

  get(panel: NotebookPanel): PairingSnapshot | null {
    return this.entries.get(panel) ?? null;
  }

  session(panel: NotebookPanel): PairingSession | null {
    return this.entries.get(panel)?.session ?? null;
  }

  setSession(panel: NotebookPanel, session: PairingSession | null): void {
    const entry = this.ensure(panel);
    entry.session = session;
    this.changed.emit(panel);
  }

  setPartners(panel: NotebookPanel, partners: Map<number, PartnerRecord>): void {
    const entry = this.ensure(panel);
    entry.partners = partners;
    this.changed.emit(panel);
  }

  remove(panel: NotebookPanel): void {
    this.entries.delete(panel);
    this.changed.emit(panel);
  }

  private ensure(panel: NotebookPanel): PairingSnapshot {
    let entry = this.entries.get(panel);
    if (!entry) {
      entry = { session: null, partners: new Map() };
      this.entries.set(panel, entry);
    }
    return entry;
  }
}

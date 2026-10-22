/** Simple change notifier shared by the app models. */
export class Emitter {
  private fns = new Set<() => void>();
  on(fn: () => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  protected emit() {
    for (const f of this.fns) f();
  }
}

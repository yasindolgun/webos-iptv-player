export class ViewNavigator<T> {
  private entries: T[];

  constructor(initialView: T) {
    this.entries = [initialView];
  }

  get current(): T {
    return this.entries[this.entries.length - 1];
  }

  get history(): readonly T[] {
    return this.entries;
  }

  navigateTo(view: T): void {
    if (view !== this.current) this.entries.push(view);
  }

  replaceView(view: T): void {
    this.entries[this.entries.length - 1] = view;
  }

  resetTo(view: T): void {
    this.entries = [view];
  }

  goBack(fallback: T): T {
    if (this.entries.length > 1) this.entries.pop();
    else this.entries[0] = fallback;
    return this.current;
  }
}

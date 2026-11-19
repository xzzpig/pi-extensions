/* One diagnostic per core lifetime; missing/unknown mode is not guessed. */
export class MouseCapabilityNotice {
  private readonly warned = new WeakSet<object>();

  observe(
    mode: string | undefined,
    owner: object | null,
    notify: (message: string) => void,
  ): void {
    if (mode !== "regular" || !owner || this.warned.has(owner)) return;
    this.warned.add(owner);
    notify("Goal-X 鼠标交互需要 Pi 全屏模式；键盘浏览与任务自动跟随仍可用。");
  }
}

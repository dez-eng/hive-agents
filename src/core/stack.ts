/**
 * 模块栈 —— v2「栈式恢复」的落点。
 *
 * 栈底是 A 的主模块，栈顶是当前执行者。借调结束弹一层就回到原角色
 * （B 借调 C，C 干完弹回 B），而不是覆盖 —— 覆盖会把借调前的身份搞丢。
 *
 * 纯函数、无副作用，也完全不碰 prompt 与缓存：切层只换用户消息尾部那段，
 * system 前缀一个字节都不动（见 prompt.ts）。
 */

/** 压一层。同一个 id 连着压没有意义，交由调用方判断 */
export function stackPush(stack: readonly string[], id: string): string[] {
  return [...stack, id];
}

/** 弹一层。**栈底永不弹出** —— 弹空了就没有当前角色了 */
export function stackPop(stack: readonly string[]): string[] {
  return stack.length > 1 ? stack.slice(0, -1) : [...stack];
}

/** 栈顶 = 当前模块 id */
export function stackTop(stack: readonly string[]): string {
  return stack.length ? stack[stack.length - 1]! : '';
}

/** 栈深。> 1 说明正在借调中，footer 用它决定要不要显示栈段 */
export function stackDepth(stack: readonly string[]): number {
  return stack.length;
}

/** 显示成 `通用›侦察›修复`，label 由调用方给（模块 title） */
export function stackLabel(stack: readonly string[], label: (id: string) => string): string {
  return stack.map(label).join('›');
}

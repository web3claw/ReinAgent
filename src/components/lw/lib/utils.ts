// LiveAgent 移植：crates/agent-ui/src/lib/shared/utils.ts
// LA 通过 extendTailwindMerge 教学 text-tiny/shadow-ui-* 等自定义 token；
// ReinAgent 侧由宿主 global.css 的 @theme 提供同名 token，这里直接复用宿主 cn。
export { cn } from "../../../lib/utils";

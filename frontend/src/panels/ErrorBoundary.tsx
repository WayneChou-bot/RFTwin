/** 視圖層級的 Error Boundary：任何一個視圖（Energy、Health…）或 3D 場景丟出 render 錯誤時，
 *  只有該區塊換成錯誤卡，Header／左右欄／KPI 列照常運作，而不是整頁白掉（React 預設會卸載整棵樹）。
 *  切換視圖（resetKey 變動）或按「重新載入視圖」會重新掛載子樹。 */
import { Component, type ReactNode } from "react";
import { useT } from "../i18n";

type Props = { resetKey: string; labels: { title: string; retry: string }; children: ReactNode };
type State = { error: Error | null };

class Boundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error) { console.error("[view] render error:", error); }
  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="viewerr" role="alert">
        <b>{this.props.labels.title}</b>
        <code>{String(this.state.error.message || this.state.error)}</code>
        <button type="button" onClick={() => this.setState({ error: null })}>{this.props.labels.retry}</button>
      </div>
    );
  }
}

export function ViewErrorBoundary({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  const T = useT();
  return <Boundary resetKey={resetKey} labels={{ title: T("err.view"), retry: T("err.retry") }}>{children}</Boundary>;
}

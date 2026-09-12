import { useEffect, useState } from "react";
import { start, useTwin } from "./state/store";
import { FactoryScene } from "./scene/FactoryScene";
import { ConnBanner, Dashboard, Header, LeftPanel, Provenance, RightPanel } from "./panels/Panels";
import { EnergyView, FlowView, HealthView, QualityView, SimulationView } from "./panels/Views";
import { useT, type TKey } from "./i18n";

/* §52：<1100 px 的手機／窄視窗——整頁改為可捲動後介面仍過度壓縮；
 * 比照 WareTwin 給明確提示（可關閉），而不是讓訪客看到擠成一團的儀表板。 */
function NarrowScreenNotice() {
  const T = useT();
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem("twin.narrowDismissed") === "1"; } catch { return false; }
  });
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1100);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 1100);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  if (!narrow || dismissed) return null;
  return (
    <div className="narrownotice" role="note">
      <b>{T("narrow.title")}</b>
      <span>{T("narrow.body")}</span>
      <button onClick={() => { setDismissed(true); try { sessionStorage.setItem("twin.narrowDismissed", "1"); } catch { /* ignore */ } }}>
        {T("narrow.continue")}</button>
    </div>
  );
}

export default function App() {
  const T = useT();
  useEffect(() => start(), []);        // §43 Connection Manager（回傳 cleanup）
  const mode = useTwin((s) => s.mode);
  const view = useTwin((s) => s.view);
  return (
    <div className="app">
      <NarrowScreenNotice />
      <Header />
      <ConnBanner />
      <div className="mid">
        <LeftPanel />
        <section className="panel center">
          <h2>{T(`view.${view}` as TKey)}{mode === "CONNECTING" ? T("app.connecting") : ""}</h2>
          {view === "3d" ? (
            <div className="c3d"><FactoryScene /></div>
          ) : (
            <div className="viewhost">
              {view === "flow" && <FlowView />}
              {view === "health" && <HealthView />}
              {view === "quality" && <QualityView />}
              {view === "energy" && <EnergyView />}
              {view === "simulation" && <SimulationView />}
            </div>
          )}
          <Provenance />
        </section>
        <RightPanel />
      </div>
      <Dashboard />
    </div>
  );
}

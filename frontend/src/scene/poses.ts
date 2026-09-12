/** 顯示層姿態表 — phase 時間分段鏡射引擎 PHASES（engine.py）。
 *
 *  座標約定（RobotArm rig 實測）：Robot 以 rotationY 對準工作位（local +x = 治具方向）。
 *  J1 yaw：+ 轉向左側 / − 轉向右側（取料盤、料箱在側面）。
 *  J2 shoulder：**負值 = 前傾**（朝治具）；0 = 直立。
 *  J3 elbow：**正值 = 抬前臂**；配合 J2 前傾決定工具高度。
 *  J5 wrist：**負值 = 工具朝下**（對著工件）。
 *  作業姿態基準：J2 −55°、J3 +30°、J5 −35° ≈ 工具落在前方 2.6 m、高 1.1 m 的治具面。 */
export type Pose = [number, number, number, number, number, number];

const d = (deg: number) => (deg * Math.PI) / 180;

/** 收攏待機：直立微前傾。 */
export const HOME: Pose = [0, d(-12), d(68), 0, d(-55), 0];
/** 治具上方作業（工具朝下）。 */
const WORK: Pose = [0, d(-55), d(30), 0, d(-38), 0];
/** 貼近工件（下壓）。 */
const WORK_LOW: Pose = [0, d(-62), d(24), 0, d(-30), 0];
/** 側邊取料（J1 轉向 + 俯身）。 */
const side = (yaw: number): Pose => [d(yaw), d(-48), d(34), 0, d(-40), 0];
/** 高位過渡（抬起移動，避免掃過治具）。 */
const LIFT: Pose = [0, d(-30), d(52), 0, d(-50), 0];

export const PHASE_TRACKS: Record<string, [string, number, Pose][]> = {
  spot_welding: [
    ["PART_DETECTED", 2, HOME],
    ["MOVE_TO_APPROACH", 6, LIFT],
    ["POSITIONING", 6, WORK],
    ["WELDING", 18, [d(6), d(-60), d(26), d(10), d(-32), d(35)]],   // 沿焊縫微移
    ["INSPECTION", 4, [d(-8), d(-50), d(34), 0, d(-42), 0]],
    ["RETURN_HOME", 4, HOME],
  ],
  precision_assembly: [
    ["PICK_COMPONENT", 6, side(58)],                                 // 供料盤在側
    ["MOVE_TO_FIXTURE", 6, LIFT],
    ["ALIGN", 4, WORK],
    ["INSERT", 6, WORK_LOW],
    ["FASTEN", 10, [d(0), d(-62), d(24), d(20), d(-28), d(120)]],    // 鎖附：J6 旋轉
    ["TORQUE_CHECK", 4, WORK],
    ["RELEASE", 4, HOME],
  ],
  machine_tending: [
    ["PICK_RAW_PART", 4, side(-62)],                                 // Infeed tray 在側
    ["OPEN_MACHINE", 2, LIFT],
    ["LOAD_MACHINE", 3, WORK_LOW],
    ["CLOSE_MACHINE", 1, LIFT],
    ["WAITING_MACHINE", 27, HOME],                                   // CNC 加工中收臂等待
    ["OPEN_MACHINE", 2, LIFT],
    ["REMOVE_PART", 3, WORK_LOW],
    ["PLACE_FINISHED_PART", 3, side(62)],                            // Outfeed 另一側
  ],
  quality_handling: [
    ["PART_ARRIVED", 8, side(-55)],                                  // 由入口取件
    ["CAPTURE_IMAGE", 6, WORK],                                      // 置於相機下
    ["INSPECTING", 6, [d(4), d(-56), d(29), d(15), d(-36), d(45)]],  // 翻轉檢面
    ["PASS_OR_FAIL", 2, WORK],
    ["SORT", 16, side(60)],                                          // 分流到 Pass/Reject
  ],
};

/** 由整週期 progress（0–1）求目標姿態：phase 內線性插值到該 phase 目標。 */
export function poseAt(process: string, cycleSec: number, progress: number): Pose {
  const track = PHASE_TRACKS[process] ?? PHASE_TRACKS.spot_welding;
  const total = track.reduce((a, [, s]) => a + s, 0);
  let t = progress * (cycleSec || total);
  let prev: Pose = track[track.length - 1][2];
  for (const [, dur, pose] of track) {
    if (t <= dur) {
      const f = Math.min(1, t / dur);
      return prev.map((p, i) => p + (pose[i] - p) * f) as Pose;
    }
    t -= dur;
    prev = pose;
  }
  return prev;
}

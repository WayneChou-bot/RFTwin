/** §50 佈局單一來源：factory_layout.json 由 scripts/sync_layout.py 從 config/ 複製
 *  （禁止手改）；引擎讀同一份。場景座標、dock、充電位、障礙預設位置皆由此推導。 */
import layoutJson from "./factory_layout.json";

export interface FactoryLayout {
  layout_id: string;
  cells: Record<string, { key: string; x: number }>;
  amr: {
    docks: Record<string, [number, number]>;
    dock_ids: Record<string, string>;
    homes: Record<string, [number, number]>;
    charging_pads: [number, number][];
    corridor_z: number;
    floor: { x_min: number; x_max: number; z_min: number; z_max: number };
  };
  obstacle_sites: Record<string, { x: number; z: number; label: string }>;
}
export const LAYOUT = layoutJson as unknown as FactoryLayout;
export const CELL_X: Record<string, number> =
  Object.fromEntries(Object.entries(LAYOUT.cells).map(([id, c]) => [id, c.x]));
export const DOCKS = LAYOUT.amr.docks;
export const DOCK_IDS = LAYOUT.amr.dock_ids;
export const AMR_HOMES = LAYOUT.amr.homes;
export const CHARGING_PADS = LAYOUT.amr.charging_pads;
export const CORRIDOR_Z = LAYOUT.amr.corridor_z;

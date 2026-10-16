export type RGB = [number, number, number];
export type ColorInput = number | RGB | `#${string}`;
export type Mode = 'pointer' | 'sun' | 'orbit' | 'fixed';

export interface SceneOptions {
  root?: HTMLElement | null;
  mode?: Mode;
  light?: { x?: number; y?: number; height?: number; color?: ColorInput; intensity?: number };
  sun?: { date?: Date | null; lat?: number | null; lon?: number | null; speed?: number };
  shadow?: { strength?: number; softness?: number; color?: ColorInput | null };
  sky?: number;
  idle?: 'auto' | 'orbit' | 'rest' | 'stay';
  orbit?: { speed?: number; rx?: number; ry?: number };
  smoothing?: number;
  observe?: boolean;
}

export interface LightState {
  kind: 'point' | 'dir';
  x: number; y: number;
  h?: number;
  dx?: number; dy?: number; altitude?: number;
  sunAltitude?: number; azimuth?: number; time?: Date;
  intensity: number;
  color: RGB; top: RGB; bottom: RGB; shadow: RGB;
}

export interface Scene {
  set(options: SceneOptions): Scene;
  setTime(when: Date | number): Scene;
  add(el: Element): Scene;
  remove(el: Element): Scene;
  refresh(): Scene;
  on(event: 'frame', fn: (light: LightState) => void): () => void;
  destroy(): void;
  readonly light: LightState | null;
  readonly time: Date;
}

export function createScene(options?: SceneOptions): Scene;
export default createScene;

export function kelvinToRgb(kelvin: number): RGB;
export function parseColor(c: ColorInput): RGB;
export function sunPosition(date: Date, lat: number, lon: number): { altitude: number; azimuth: number };
export function skyAt(altitude: number): { top: RGB; bottom: RGB; shadow: RGB; color: RGB; intensity: number };

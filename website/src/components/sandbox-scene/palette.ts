import { Color, Vector3 } from "three";
import { lerp } from "./helpers";

/** Everything that changes between the light (day) and dark (night) themes. */
export interface Palette {
  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  keyColor: Color;
  keyIntensity: number;
  keyDirection: Vector3;
  waterShallow: Color;
  waterDeep: Color;
  waterFoam: Color;
  cloud: Color;
  cloudOpacity: number;
  shadowOpacity: number;
}

const DAY: Palette = {
  hemiSky: new Color("#dff0ff"),
  hemiGround: new Color("#f6dcae"),
  hemiIntensity: 2.1,
  keyColor: new Color("#fff3dc"),
  keyIntensity: 2.7,
  keyDirection: new Vector3(0.45, 1, 0.65).normalize(),
  waterShallow: new Color("#8ee7e2"),
  waterDeep: new Color("#2f8fdc"),
  waterFoam: new Color("#ffffff"),
  cloud: new Color("#ffffff"),
  cloudOpacity: 0.95,
  shadowOpacity: 0.28,
};

const NIGHT: Palette = {
  hemiSky: new Color("#7a86d0"),
  hemiGround: new Color("#5a4560"),
  hemiIntensity: 1.3,
  keyColor: new Color("#c9d2ff"),
  keyIntensity: 1.45,
  keyDirection: new Vector3(-0.55, 1, 0.55).normalize(),
  waterShallow: new Color("#2f7598"),
  waterDeep: new Color("#0f2550"),
  waterFoam: new Color("#a9dcff"),
  cloud: new Color("#5b6aa8"),
  cloudOpacity: 0.35,
  shadowOpacity: 0.4,
};

export function createPalette(): Palette {
  return {
    ...DAY,
    hemiSky: DAY.hemiSky.clone(),
    hemiGround: DAY.hemiGround.clone(),
    keyColor: DAY.keyColor.clone(),
    keyDirection: DAY.keyDirection.clone(),
    waterShallow: DAY.waterShallow.clone(),
    waterDeep: DAY.waterDeep.clone(),
    waterFoam: DAY.waterFoam.clone(),
    cloud: DAY.cloud.clone(),
  };
}

/** Writes the mix of the day and night palettes (0 = day, 1 = night) into `target`. */
export function mixPalette(target: Palette, night: number): void {
  target.hemiSky.lerpColors(DAY.hemiSky, NIGHT.hemiSky, night);
  target.hemiGround.lerpColors(DAY.hemiGround, NIGHT.hemiGround, night);
  target.hemiIntensity = lerp(DAY.hemiIntensity, NIGHT.hemiIntensity, night);
  target.keyColor.lerpColors(DAY.keyColor, NIGHT.keyColor, night);
  target.keyIntensity = lerp(DAY.keyIntensity, NIGHT.keyIntensity, night);
  target.keyDirection.lerpVectors(DAY.keyDirection, NIGHT.keyDirection, night).normalize();
  target.waterShallow.lerpColors(DAY.waterShallow, NIGHT.waterShallow, night);
  target.waterDeep.lerpColors(DAY.waterDeep, NIGHT.waterDeep, night);
  target.waterFoam.lerpColors(DAY.waterFoam, NIGHT.waterFoam, night);
  target.cloud.lerpColors(DAY.cloud, NIGHT.cloud, night);
  target.cloudOpacity = lerp(DAY.cloudOpacity, NIGHT.cloudOpacity, night);
  target.shadowOpacity = lerp(DAY.shadowOpacity, NIGHT.shadowOpacity, night);
}

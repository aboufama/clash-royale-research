// Types for sim/viewer/assets/manifest.json (written by tools/art/bake_web.py).

export interface ActionArt {
  export: string; // prefix; full export = `${export}_${dir}`
  dirs: number; // authored directions over 180 degrees (9 -> 16 total, 18 -> 34)
  frames: number;
  fps: number;
  labels?: Record<string, string>; // frame -> label (e.g. "action_frame" = hit)
  actionFrame?: number;
}

export interface ClipRef {
  sc: string;
  export: string;
  frames?: number;
  fps?: number;
  labels?: Record<string, string>;
}

export interface CharacterArt {
  sc: string;
  blue: string;
  red: string;
  scale: number; // percent
  actions: Record<string, ActionArt>;
  actionsRed?: Record<string, ActionArt>;
  card?: string;
  flyingHeight?: number;
  collisionRadius?: number;
  shadowScaleX?: number;
  shadowScaleY?: number;
  shadowSkew?: number;
  shadowX?: number;
  shadowY?: number;
  shadowCustom?: ClipRef;
  healthBar?: string;
  healthBarOffsetY?: number;
  healthBarOffsetYBlue?: number;
  healthBarOffsetYRed?: number;
  hideHealthbar?: boolean;
  effects?: Record<string, string>; // spawnEffect, deathEffect, attackStartEffect, ...
  deployBaseAnimExportName?: ClipRef; // deploy "filter" clip (unit drop + flash)
  projectile?: string;
  customFirstProjectile?: string;
  [k: string]: unknown;
}

export interface ProjectileArt {
  sc?: string;
  export?: string;
  redExport?: string;
  shadow?: string;
  redShadow?: string;
  frames?: number;
  fps?: number;
  scale?: number;
  speed?: number;
  gravity?: number;
  constantHeight?: number;
  use360Frames?: boolean;
  shadowDisableRotate?: boolean;
  hitEffect?: string;
  trailEffect?: string;
  deathEffect?: string;
  [k: string]: unknown;
}

export interface EffectComponent {
  type: 'SWF' | 'Filter' | 'Effect' | 'ParticleEmitter';
  layer: string; // Ground, Base, Shadow, Object, Above, GroundAbility
  time?: number; // ms delay
  scale?: number; // percent
  sc?: string;
  export?: string;
  frames?: number;
  fps?: number;
  labels?: Record<string, string>;
  effect?: string;
  emitter?: string;
}

export interface EffectDef {
  components: EffectComponent[];
  Loop?: boolean;
  FollowParent?: boolean;
  Scale?: number;
  ShakeScreen?: number;
  ForcedLength?: number;
  EnemyVersion?: string;
  [k: string]: unknown;
}

export interface EmitterDef {
  particles: ClipRef[];
  trail?: ClipRef;
  ParticleCount?: number;
  MinLife?: number;
  MaxLife?: number;
  ParticleMinLife?: number;
  ParticleMaxLife?: number;
  ParticleMinInterval?: number;
  ParticleMaxInterval?: number;
  ParticleMinAngle?: number;
  ParticleMaxAngle?: number;
  ParticleRandomAngle?: boolean;
  ParticleAngleRelativeToParent?: boolean;
  ParticleMinRadius?: number;
  ParticleMaxRadius?: number;
  ParticleMinSpeed?: number;
  ParticleMaxSpeed?: number;
  ParticleStartZ?: number;
  ParticleMinVelocityZ?: number;
  ParticleMaxVelocityZ?: number;
  ParticleGravity?: number;
  ParticleStartX?: number;
  ParticleStartXYAreaRadius?: number;
  ParticleRadiusAspect?: number;
  StartScale?: number;
  EndScale?: number;
  RandomScale?: number;
  FadeInDuration?: number;
  FadeOutDuration?: number;
  Inertia?: number;
  RotateToDirection?: boolean;
  RotateMinSpeed?: number;
  RotateMaxSpeed?: number;
  AngularSpeed?: number;
  LoopParticleClip?: boolean;
  PlayParticleClipOnce?: boolean;
  NoBounce?: boolean;
  StopOnBounce?: boolean;
  Shadow?: boolean;
  ShadowMulR?: number;
  ShadowMulG?: number;
  ShadowMulB?: number;
  ShadowMulA?: number;
  ParticleMinTailLength?: number;
  ParticleMaxTailLength?: number;
  InverseSpeed?: boolean;
  ParticlesFollowParent?: boolean;
  EnemyVersion?: string;
  [k: string]: unknown;
}

export interface ArenaObject {
  deco: string;
  sc: string;
  export: string;
  x: number;
  y: number; // y DOWN from the red edge
  layer: string;
  frames?: number;
  fps?: number;
  animate?: boolean;
  shadowScaleX?: number;
  shadowScaleY?: number;
  shadowX?: number;
  shadowY?: number;
  shadowSkew?: number;
}

export interface ArenaArt {
  location: string;
  sc: string;
  export: string;
  objects: ArenaObject[];
  pxPerTileX: number;
  pxPerTileY: number;
  originPx: [number, number];
  originGame: [number, number];
  zPxPer1000: number;
  shadow: Record<string, number>;
  clouds?: { sc: string; export: string; count?: number; minscale?: number; maxscale?: number; minspeed?: number;
    maxspeed?: number; minalpha?: number; maxalpha?: number; randomflip?: boolean };
  [k: string]: unknown;
}

export interface TowerArt {
  positions: { king: [number, number]; princessLeft: [number, number]; princessRight: [number, number] };
  king: {
    sc: string; blue: string; red: string; frames: number; fps: number; labels: Record<string, string>;
    turretChild: string; kingChild: string; turretFrames: number; destroyed: string;
    king: { sc: string; blue: string; red: string; frames: number; fps: number };
    healthBar?: string; healthBarOffsetYBlue?: number; healthBarOffsetYRed?: number;
    shadow: Record<string, number>; effects: Record<string, string>; projectile?: string;
  };
  princess: {
    sc: string; base: { blue: string; red: string }; top: { blue: string; red: string }; character: string;
    destroyed: string; healthBar?: string; healthBarOffsetYBlue?: number; healthBarOffsetYRed?: number;
    shadow: Record<string, number>; effects: Record<string, string>; projectile?: string;
  };
}

export interface CardArt {
  sc: string;
  export: string;
  elixir?: number;
  rarity?: string;
  [k: string]: unknown;
}

export interface Manifest {
  version: number;
  libs: Record<string, { json: string }>;
  characters: Record<string, CharacterArt>;
  spells: Record<string, { card: string; projectile?: string; effect?: string; [k: string]: unknown }>;
  projectiles: Record<string, ProjectileArt>;
  effects: Record<string, EffectDef>;
  emitters: Record<string, EmitterDef>;
  towers: TowerArt;
  arena: ArenaArt;
  cards: Record<string, CardArt>;
  hud: { sc: string; exports: string[]; healthBars: Record<string, Record<string, string | number | boolean>>;
    healthBarParts: Record<string, Record<string, unknown>> };
  fonts: Record<string, string>;
}

export async function loadManifest(baseUrl: string): Promise<Manifest> {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/manifest.json`);
  if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status} (run tools/art/bake_web.py)`);
  return (await r.json()) as Manifest;
}

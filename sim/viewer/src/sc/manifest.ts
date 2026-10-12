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

/** Single labelled clip of a building (or a character drawn without direction exports). */
export interface BuildingClip {
  export: string;
  frames: number;
  fps: number;
  labels?: Record<string, string>;
  turretChild?: string; // child whose frame is the aim (19 frames over 180 degrees, up -> right -> down)
  turretFrames?: number;
}

export interface CharacterArt {
  kind?: 'character' | 'building';
  /** buildings / single-clip units: blue + red clips */
  clip?: { blue?: BuildingClip; red?: BuildingClip };
  /** buildings drawn in two parts (e.g. a top over the attached character) */
  top?: { blue?: ClipRef; red?: ClipRef };
  turretMovement?: number;
  hasRotationOnTimeline?: boolean;
  lifeTime?: number;
  deathAreaEffect?: string;
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
  spawnDeployBaseAnim?: ClipRef; // +0x278: the filter a spawned copy of this character takes (0xf8aac8)
  deathSpawnDeployBaseAnim?: ClipRef; // +0x288: the filter for this character's death spawn (0xf83990)
  projectile?: string;
  customFirstProjectile?: string;
  // character data read by the client's view update (sc/anim.ts)
  hitSpeed?: number;
  walkingSpeedTweakPercentage?: number;
  stopMovementAfterMS?: number;
  waitMS?: number;
  dontStopMoveAnim?: boolean;
  rotateAngleSpeed?: number;
  tryToFinishAttackAnimation?: boolean;
  tryToFinishAttackAnimationBeforeNextAttack?: boolean;
  animationsKeepLastFrame?: boolean;
  jumpEnabled?: number;
  // building clip views (sc/anim.ts animateBuilding)
  hidesWhenNotAttacking?: boolean;
  hideTimeMs?: number;
  upTimeMs?: number;
  manaGenerateTimeMs?: number;
  /** DamageExportName + _down/_left/_up/_right hit filter clips */
  damageFilters?: Record<'down' | 'left' | 'up' | 'right', ClipRef>;
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
  // read by the client's projectile view (sc/projectile_view.ts)
  homing?: boolean;
  projectileRadius?: number;
  projectileRange?: number;
  checkCollisions?: boolean;
  scatter?: string;
  minimumLengthForVisualAngleCalculation?: number;
  hideWhenDelayed?: boolean;
  alwaysResetAnimation?: boolean;
  spawnProjectile?: string;
  /** +0x158: the filter of the characters it spawns at its hit (0xf9188c -> view vt+0x140) */
  spawnDeployBaseAnim?: ClipRef;
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
  /** SWF FlashWidth: the beam clip's authored length (targeted SWF, sc/beam.ts); −1 rotate only */
  flashWidth?: number;
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
  /** client_globals SHADOW_BLUR_DISTANCE (hundredths; composite tap distance factor) */
  shadowBlurDistance?: number;
  clouds?: { sc: string; export: string; count?: number; minscale?: number; maxscale?: number; minspeed?: number;
    maxspeed?: number; minalpha?: number; maxalpha?: number; randomflip?: boolean };
  [k: string]: unknown;
}

export interface TowerArt {
  positions: { king: [number, number]; princessLeft: [number, number]; princessRight: [number, number] };
  king: {
    sc: string; blue: string; red: string; frames: number; fps: number; labels: Record<string, string>;
    turretChild: string; kingChild: string; turretFrames: number; turretMovement?: number;
    destroyed: string; // rubble export (drawn by drawKingTower(destroyed)); destroyedLayer: 'Base' | 'Ground'
    destroyedLayer?: string;
    king: { sc: string; blue: string; red: string; frames: number; fps: number };
    scale?: number; attachedHeight?: number;
    healthBar?: string; healthBarOffsetYBlue?: number; healthBarOffsetYRed?: number;
    shadow: Record<string, number>; effects: Record<string, string>; projectile?: string;
    projectileStartZ?: number; collisionRadius?: number;
  };
  princess: {
    sc: string; base: { blue: string; red: string }; top: { blue: string; red: string }; character: string;
    destroyed: string; destroyedLayer?: string;
    scale?: number; attachedHeight?: number;
    healthBar?: string; healthBarOffsetYBlue?: number; healthBarOffsetYRed?: number;
    shadow: Record<string, number>; effects: Record<string, string>; projectile?: string;
    projectileStartZ?: number; collisionRadius?: number;
  };
}

export interface CardArt {
  sc: string;
  export: string;
  elixir?: number;
  rarity?: string;
  [k: string]: unknown;
}

export interface AreaEffectArt {
  radius?: number; // game units (engine data; the view does not scale by it)
  lifeDuration?: number; // ms
  hitSpeed?: number;
  buff?: string;
  buffTime?: number;
  pushback?: number;
  projectile?: string; // e.g. Lightning bolts
  spawnAreaEffectObject?: string;
  spawnCharacter?: string;
  /** the view's effects (sc/area_view.ts, 0x833b84): scaledEffect (time stretched over the life),
   * loopingEffect, oneShotEffect, hitEffect (each pulse), noFollowObjectEffect; spawnEffect (spawned
   * characters') */
  effects: Record<string, string>;
  clip?: ClipRef;
  [k: string]: unknown;
}

export interface BuffArt {
  speedMultiplier?: number;
  hitSpeedMultiplier?: number;
  spawnSpeedMultiplier?: number;
  damagePerSecond?: number;
  /** colour filter clip applied to the buffed unit (loop = !FilterInheritLifeDuration, 0x8348c8) */
  filter?: ClipRef & { loop: boolean };
  filterInheritLifeDuration?: boolean;
  effect?: string; // started on the unit with the buff view, deleted with it (0x8348c8 / 0x834e54)
  markEffect?: string;
  [k: string]: unknown;
}

export interface Manifest {
  version: number;
  areaEffects?: Record<string, AreaEffectArt>;
  buffs?: Record<string, BuffArt>;
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
    healthBarParts: Record<string, Record<string, unknown>>;
    /** image/range.png copied by the bake (drag radius indicator texture) */
    rangeImage?: string;
    /** texts.csv EN strings the HUD fills in (TID_* -> text) */
    texts?: Record<string, string>;
    /** sc/ui_common.sc 9-slice buttons and popup backgrounds (the simulator's side panel) */
    common?: { sc: string; exports: string[] } };
  fonts: Record<string, string>;
}

export async function loadManifest(baseUrl: string): Promise<Manifest> {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/manifest.json`);
  if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status} (run tools/art/bake_web.py)`);
  return (await r.json()) as Manifest;
}

export const FPS = 30
export const DURATION_S = 66
export const DURATION_FRAMES = FPS * DURATION_S

/** Scene windows in seconds: [start, end] */
export const SCENES = {
  opening: [0, 5],
  terminal: [5, 27],
  control: [27, 36],
  features: [36, 48],
  ecosystem: [48, 58],
  cta: [58, 66],
} as const

/** Terminal script timing (absolute seconds) */
export const TERM = {
  cmd1Start: 6.0,
  sys1At: 8.9,
  sys2At: 9.8,
  gapAt: 10.4,
  agent1At: 10.9,
  agent2At: 12.0,
  permAt: 13.2,
  permApprove: 15.2,
  patchAt: 16.2,
  testsAt: 17.2,
  gap2At: 18.0,
  cmd2Start: 18.4,
  commitAt: 21.0,
  captionIn: 22.6,
  captionOut: 26.0,
} as const

/** CTA install typing */
export const INSTALL = {
  text: 'npm install --global @volund/cli',
  startLocal: 1.9,
  cps: 22,
} as const

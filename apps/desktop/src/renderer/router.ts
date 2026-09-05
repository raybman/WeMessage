/**
 * The closed screen registry (F-113).
 *
 * The wireframe set IS the spec for S8. Scope explosion in a GUI slice is
 * not a risk to be monitored, it is a rule to be mechanised, so the screens
 * are enumerated here and `test/arch.spec.ts` row 9 asserts both this array
 * and the `screens/` directory set against the §1.7 lists. A seventeenth
 * idea fails the tree, and the failure is the prompt to argue it into the
 * plan before writing it.
 *
 * `wizard` is deliberately not a `SCREENS` member: it is a modal flow with
 * its own step registry and its own exit states, not a destination in the
 * sidebar. It has a `screens/wizard/` directory because its steps are
 * screens in every sense except navigation, which is why row 9 asserts the
 * directory set as the registry PLUS wizard rather than as the registry.
 */
export const SCREENS = [
  'queue',
  'rules',
  'schedule',
  'people',
  'audit',
  'settings',
] as const;

/** The onboarding flow, in order. Step 5 is the only send in the app. */
export const WIZARD_STEPS = [
  'welcome',
  'full-disk',
  'automation',
  'optional',
  'send-test',
] as const;

export type Screen = (typeof SCREENS)[number];
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** `queue` is where a deep link with an unknown path lands (Sc 16). */
export const DEFAULT_SCREEN: Screen = 'queue';

/** Whether `value` is a screen the app can navigate to. */
export function isScreen(value: string): value is Screen {
  return (SCREENS as readonly string[]).includes(value);
}

// Whether the notch is up on this desktop. While it is, the notch makes the
// one sound for an approval or a question, so the banner stays quiet.
let active = false;

export const notchActive = () => active;

export function setNotchActive(on: boolean) {
  active = on;
}

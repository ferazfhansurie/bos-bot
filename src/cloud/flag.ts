// Cloud rooms (bos 2.0) stay off unless the build or dev server was started
// with BOS_CLOUD_ROOMS=1. There is no in-app toggle in slice 1.
declare const __BOS_CLOUD_ROOMS__: boolean | undefined;

export function cloudRoomsEnabled(): boolean {
  return typeof __BOS_CLOUD_ROOMS__ !== "undefined" && __BOS_CLOUD_ROOMS__ === true;
}

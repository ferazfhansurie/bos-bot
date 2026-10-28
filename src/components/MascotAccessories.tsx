// What a bot wears, as one <g> in its flat body's 100-unit box. Drawn inside
// the mascot's own motion groups, so a squash, hop or spin carries the hat
// with the body and nothing here runs per frame.
import { memo, useMemo } from "react";

import { mascotAccessoryMarkup } from "../../shared/mascot-accessory-art";

export const MascotAccessories = memo(function MascotAccessories({ accessories, bodyId, color, centre }: {
  accessories: unknown;
  bodyId: unknown;
  color: string | null | undefined;
  /** the face centre this surface draws its glyph eyes around */
  centre?: [number, number];
}) {
  const cx = centre?.[0], cy = centre?.[1];
  const markup = useMemo(
    () => mascotAccessoryMarkup({ accessories, bodyId, color, centre: cx === undefined || cy === undefined ? undefined : [cx, cy] }),
    // the accessories object is often rebuilt with the same slots
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(accessories ?? null), bodyId, color, cx, cy],
  );
  if (!markup) return null;
  // markup is built only from catalog ids and our own numbers
  return <g className="bos-mascot-accessories" dangerouslySetInnerHTML={{ __html: markup }} />;
});

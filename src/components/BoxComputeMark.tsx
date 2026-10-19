import type { SVGProps } from "react";

/** BoxCompute's mark from boxcompute.ai/favicon.svg: the box body follows
 * the text colour like the lucide icons beside it, the slot is cut through
 * so it reads on any background, and the orange key stays theirs. */
export function BoxComputeMark({ size = 16, ...props }: { size?: number | string } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="28 28 200 200" width={size} height={size} role="img" aria-label="BoxCompute" {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M54 28h124l50 50v32l-24 18 24 18v56q0 26-26 26H74l-46-46V54q0-26 26-26Z M64 113h52l58-44h28v30h-18l-38 29 38 29h18v30h-28l-58-44H64v-30Z"
      />
      <path fill="#CE704C" d="M174 157h28v30h-28l-20-15 20-15Z" />
    </svg>
  );
}

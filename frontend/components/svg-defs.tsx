/**
 * The page's two SVG filters, mounted once. Both are referenced from CSS by id,
 * so they have to exist exactly once per document — not once per card, which is
 * why they live here rather than beside the components that use them.
 *
 * Kept out of `display: none`: a filter defined inside a display-none subtree is
 * unreliable across engines. Zero-sized and absolutely positioned instead.
 */
export function SvgDefs() {
  return (
    <svg
      aria-hidden
      focusable="false"
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
    >
      <defs>
        {/* The spinning counter's motion streak. Vertical-only on purpose:
            `stdDeviation="0 3"` blurs along the axis the reel travels, where
            CSS `blur()` would smear a 10px-wide digit sideways into mush. */}
        <filter id="flarepulse-reel-blur" x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation="0 3" />
        </filter>

        {/* The metaball chain from gooey.jakubantalik.com: blur the layer, push
            the blurred alpha through a steep contrast so the soft edges snap
            back into one hard silhouette, then composite the original graphic
            back inside that silhouette. Two shapes that overlap after the blur
            come out as a single merged blob; as they separate they stretch and
            pinch apart. The alpha row is the recipe's own formula —
            `0 0 0 C (0.5 - C * 0.41667)`, here with C = 18. */}
        <filter
          id="flarepulse-goo"
          colorInterpolationFilters="sRGB"
          x="-20%"
          y="-60%"
          width="140%"
          height="220%"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"
            result="goo"
          />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
        {/* The hero's refraction, from freefrontend's liquid-glass recipe. A
            fractal-noise field, blurred into a smooth height map, displaces the
            backdrop three times at falling scales; each pass contributes one
            colour channel and the three are screened back together, which is
            what puts a faint red/blue fringe on high-contrast edges the way real
            glass does. The last blur softens the seam a displacement leaves at
            the card's own border.

            Referenced from `backdrop-filter`, so it distorts what is behind the
            hero and never its text — the text layer is a child and no filter on
            an ancestor's backdrop can reach it. */}
        <filter
          id="flarepulse-refract"
          colorInterpolationFilters="sRGB"
          x="-6%"
          y="-6%"
          width="112%"
          height="112%"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.006 0.012"
            numOctaves="2"
            seed="11"
            result="noise"
          />
          <feGaussianBlur in="noise" stdDeviation="4" result="map" />

          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale="26"
            xChannelSelector="R"
            yChannelSelector="G"
            result="far"
          />
          <feColorMatrix
            in="far"
            type="matrix"
            values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="red"
          />

          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale="20"
            xChannelSelector="R"
            yChannelSelector="G"
            result="mid"
          />
          <feColorMatrix
            in="mid"
            type="matrix"
            values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="green"
          />

          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale="14"
            xChannelSelector="R"
            yChannelSelector="G"
            result="near"
          />
          <feColorMatrix
            in="near"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
            result="blue"
          />

          <feBlend in="red" in2="green" mode="screen" result="rg" />
          <feBlend in="rg" in2="blue" mode="screen" result="rgb" />
          <feGaussianBlur in="rgb" stdDeviation="0.4" />
        </filter>
      </defs>
    </svg>
  );
}

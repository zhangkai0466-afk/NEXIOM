/** Centerlines of the supplied Gc_108_line-PieChart.svg, normalized to the UI icon weight. */
export function VisualizationIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-83 -83 1190 1190" fill="none" stroke="currentColor" aria-hidden="true" focusable="false">
      {/* The source has 96-unit filled outlines; 81.8125 / 1190 matches 1.65 / 24. */}
      <path d="M512 512V64A448 448 0 0 1 960 512Z" strokeWidth={81.8125} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M384 139.22846A416 416 0 1 0 884.77154 640" strokeWidth={81.8125} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

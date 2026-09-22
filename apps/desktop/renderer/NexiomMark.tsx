export function NexiomMark({ className = "" }: { className?: string }) {
  return <svg className={`nexiom-mark ${className}`.trim()} viewBox="25 11 62 92" aria-hidden="true" focusable="false">
    <path d="M31 17V72L46 87V76L39 69V36L66 63V52Z" />
    <path d="M66 27V38L73 45V78L46 51V62L81 97V42Z" />
  </svg>;
}

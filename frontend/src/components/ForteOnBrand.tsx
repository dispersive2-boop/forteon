const styles = {
  sidebar: { size: 38, text: "text-[22px] text-white", accent: "text-[#60A5FA]" },
  light: { size: 38, text: "text-[22px] text-ink", accent: "text-primary" },
};

export function ForteOnBrand({ variant = "sidebar" }: { variant?: keyof typeof styles }) {
  const { size, text, accent } = styles[variant];
  return (
    <span className="inline-flex items-center gap-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-mark.svg" alt="" width={size} height={size} className="shrink-0" />
      <span className={`whitespace-nowrap font-semibold leading-none tracking-[-0.035em] ${text}`}>
        Forte<span className={accent}>On</span>
      </span>
    </span>
  );
}

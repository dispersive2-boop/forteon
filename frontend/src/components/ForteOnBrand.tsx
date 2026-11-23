export function ForteOnBrand({ variant = "sidebar" }: { variant?: "sidebar" | "light" }) {
  return (
    <span
      role="img"
      aria-label="ForteOn"
      className={`forteon-brand ${variant === "sidebar" ? "text-white" : "text-ink"}`}
    />
  );
}

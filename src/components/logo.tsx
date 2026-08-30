export function Logo({ size = 32 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- local static asset; matches Avatar convention
    <img
      src="/logo.png"
      alt="DevHub logo"
      width={size}
      height={size}
      className="logo"
      style={{ borderRadius: size * 0.14 }}
    />
  );
}
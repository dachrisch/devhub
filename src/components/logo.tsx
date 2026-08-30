import Image from 'next/image';

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <Image
      src="/devhub-logo.png"
      alt="DevHub logo"
      width={size}
      height={size}
      loading="lazy"
      fill
    />
  );
}
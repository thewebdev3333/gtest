import logoAsset from "@/assets/gwave-logo.svg";

export default function GLogo({ className = "" }: { className?: string }) {
  return <img src={logoAsset} alt="G Wave" className={className} />;
}
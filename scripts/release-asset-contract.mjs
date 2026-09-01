export const releaseTagPattern = /^v\d+\.\d+\.\d+$/;

export function getReleaseAssetContract(tag) {
  if (!releaseTagPattern.test(tag ?? "")) {
    throw new Error(`release tag must match vX.Y.Z (received: ${tag ?? "empty"})`);
  }

  const updater = {
    mac: `Chimera-Switch-${tag}-macOS.tar.gz`,
    windowsX64: `Chimera-Switch-${tag}-Windows.msi`,
    windowsArm64: `Chimera-Switch-${tag}-Windows-arm64.msi`,
    linuxX64: `Chimera-Switch-${tag}-Linux-x86_64.AppImage`,
    linuxArm64: `Chimera-Switch-${tag}-Linux-arm64.AppImage`,
  };
  const expectedPlatforms = {
    "darwin-aarch64": updater.mac,
    "darwin-x86_64": updater.mac,
    "windows-x86_64": updater.windowsX64,
    "windows-aarch64": updater.windowsArm64,
    "linux-x86_64": updater.linuxX64,
    "linux-aarch64": updater.linuxArm64,
  };
  const requiredUpdater = Object.values(updater);
  const expectedUserAssets = [
    `Chimera-Switch-${tag}-macOS.dmg`,
    `Chimera-Switch-${tag}-macOS.zip`,
    `Chimera-Switch-${tag}-Windows-Portable.zip`,
    `Chimera-Switch-${tag}-Windows-arm64-Portable.zip`,
    `Chimera-Switch-${tag}-Linux-x86_64.deb`,
    `Chimera-Switch-${tag}-Linux-x86_64.rpm`,
    `Chimera-Switch-${tag}-Linux-arm64.deb`,
    `Chimera-Switch-${tag}-Linux-arm64.rpm`,
  ];
  const signableAssets = [...requiredUpdater, ...expectedUserAssets];
  const expectedSignatures = signableAssets.map((name) => `${name}.sig`);
  const provenanceName = "provenance.json";
  const provenanceSignatureName = `${provenanceName}.sig`;
  const latestAssetName = "latest.json";
  const publicAssetNames = [
    ...signableAssets,
    ...expectedSignatures,
    provenanceName,
    provenanceSignatureName,
    latestAssetName,
  ].sort();

  return {
    updater,
    expectedPlatforms,
    requiredUpdater,
    expectedUserAssets,
    mandatoryUserAssets: expectedUserAssets,
    signableAssets,
    expectedSignatures,
    provenanceName,
    provenanceSignatureName,
    latestAssetName,
    publicAssetNames,
  };
}

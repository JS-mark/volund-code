# DRY-RUN FIXTURE — NOT PUBLISHED; URLs and checksums are deterministic placeholders
class VolundCode < Formula
  desc "Volund CLI — Open, model-agnostic AI coding CLI"
  homepage "https://github.com/JS-mark/volund-code"
  version "0.1.0-rc.1"
  license "Apache-2.0"

  on_arm do
    url "https://example.invalid/volund-code/releases/download/v0.1.0-rc.1/volund-code-darwin-arm64.tar.gz"
    sha256 "1111111111111111111111111111111111111111111111111111111111111111"
    # Tier: None; L4 native evidence is not authorized
  end

  on_intel do
    url "https://example.invalid/volund-code/releases/download/v0.1.0-rc.1/volund-code-darwin-x64.tar.gz"
    sha256 "2222222222222222222222222222222222222222222222222222222222222222"
    # Tier: None; L4 native evidence is not authorized
  end

  def install
    bin.install "volund"
    bin.install_symlink "volund" => "volund"
  end
end

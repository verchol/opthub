class Opthub < Formula
  desc "Find out whether a cheaper way of running a coding agent does the same job"
  homepage "https://github.com/verchol/opthub"
  url "file:///path/to/opthub/app/packaging/dist/opthub-0.2.0.tar.gz"   # rewritten by app/packaging/make-dist.sh
  sha256 "3e77cf4c6486b2c410815ad9269a82a8b309bb78fa55091ec444d7dfc09b664d"
  version "0.2.0"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    libexec.glob("lib/node_modules/opthub/app/*.mjs").each { |f| chmod 0755, f }

    # A wrapper rather than a symlink, so OPT_HOME is always set: the harness
    # writes results, exports and tuning output, and the Cellar is the wrong
    # place for any of it — it is replaced on every upgrade.
    (bin/"opt").write <<~SH
      #!/bin/bash
      export OPT_HOME="${OPT_HOME:-$HOME/.opthub}"
      mkdir -p "$OPT_HOME/results" "$OPT_HOME/exports"
      exec "#{Formula["node"].opt_bin}/node" \\
        "#{libexec}/lib/node_modules/opthub/app/opt.mjs" "$@"
    SH
    chmod 0755, bin/"opt"
  end

  def caveats
    <<~EOS
      Runs and reports are written to ~/.opthub (override with OPT_HOME).

      Reading your own sessions needs nothing: `opt sessions` and `opt hub start`
      work off the transcripts Claude Code already keeps in ~/.claude/projects.

      Running an experiment boots cloud sandboxes and costs money, so it needs
      credentials in ~/.opthub/.env:

        E2B_API_KEY=...
        ANTHROPIC_API_KEY=...        # or AWS_* for Bedrock

      Check what is wired up with:  opt secrets
    EOS
  end

  test do
    assert_match "harness experiment monitor", shell_output("#{bin}/opt --help")
    assert_match "no runs", shell_output("OPT_HOME=#{testpath} #{bin}/opt ls")
  end
end

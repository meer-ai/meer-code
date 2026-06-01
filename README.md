# Meer Code

Meer Code is the desktop and web GUI for Meer, an open source coding agent harness.

## Project origin

Meer Code is open source and based on
[T3 Code](https://github.com/pingdotgg/t3code), an open source GUI for coding
agents. The project has been rebranded and adapted for Meer, and future
development may move in a different direction from upstream T3 Code.

The original T3 Code copyright and MIT license notices are preserved in this
repository. See [NOTICE](./NOTICE) and [LICENSE](./LICENSE).

## Installation

> [!WARNING]
> Meer Code is currently focused on Meer CLI.
> Install and authenticate Meer before use:
>
> - Meer: install the Meer CLI and make sure `meer` is available on `PATH`

### Run without installing

```bash
npx meer-code
```

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/meer-ai/meer-code/releases), or from your favorite package registry when packages are available:

#### Windows (`winget`)

```bash
winget install MeerAI.MeerCode
```

#### macOS (Homebrew)

```bash
brew install --cask meer-code
```

#### Arch Linux (AUR)

```bash
yay -S meer-code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Observability guide: [docs/observability.md](./docs/observability.md)

## If you REALLY want to contribute still.... read this first

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
bun install .
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/VCepYnqAU).

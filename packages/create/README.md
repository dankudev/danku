# @dankudev/create

Create a danku project.

```bash
pnpm create @dankudev my-app
pnpm dlx @dankudev/create my-app
vp create @dankudev -- my-app
```

## Options

- `<name>`: project and directory name (lowercase letters, digits and dashes).
- `--preset saas|saas-split`: optional; not available yet.

## Development

```bash
vp install
vp test
vp pack
node bin/create.mjs my-app
```

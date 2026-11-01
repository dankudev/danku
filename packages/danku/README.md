# @dankudev/danku

Create a danku project, then declare its cloud resources in `danku/deploy.ts` and deploy them, without a state file.

```bash
vpx @dankudev/danku create my-app saas   # a new repository in ./my-app
```

Inside the project, danku is a devDependency: package.json scripts call `danku …` directly, and in a terminal you run it with `vpx danku …` (or `vp exec danku …`).

## Commands

- `danku create <project> <preset>`: a new repository with a Vite+ monorepo and a SvelteKit app on Cloudflare Workers. `<project>` is the folder and project name (lowercase letters, digits and dashes); `<preset>` is `localbusiness` or `saas`, which create the same base project for now. Refuses to run inside an existing repository.
- `danku generate`: writes the files apps need from `danku/deploy.ts`, today each Worker's `wrangler.jsonc` and its types. Offline; inside an app's folder it only generates that app.
- `danku deploy`: makes the cloud match `danku/deploy.ts`. With `CI` set it deploys production; anywhere else it skips kinds local tools provide.

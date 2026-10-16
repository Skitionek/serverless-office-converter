# Notes for Claude

## Git

- Author and commit as the repository owner, **Dominik Maszczyk <Skitionek@gmail.com>**, never
  as Claude. Cloud containers default to `Claude <noreply@anthropic.com>`, so before the first
  commit in a fresh clone run:

  ```sh
  git config user.name "Dominik Maszczyk"
  git config user.email "Skitionek@gmail.com"
  ```

  Check with `git log --format='%an <%ae>' -1` after committing.

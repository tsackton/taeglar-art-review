# Taelgar art review

This repository holds the shared decisions for the Vault restyle gallery. Reviewers use their own copy of the illustrated catalog. Open `vault-restyle/index.html` in that copy. The `gallery` folder here contains updates for the review interface.

## Review an illustration

1. Enter the name you want collaborators to see. Choose an original or a restyle. Use **Use with edits** to record a change you want made to the chosen image.
2. **Request review** puts the illustration in the collaboration queue. Add a review comment with the question or change you want someone to check. Image notes can also be posted independently.
3. A collaborator clicks **Sync**, filters **Review** to **Needs review**, and can filter further by requester. Open the illustration, inspect the selection in the lightbox, then approve or reject it with a comment. Sync again to share the response.

## Connect to GitHub

Click **Sync** in the gallery. To push, enter your own GitHub token for an account with write access to this repository. The page keeps the token in memory for the open tab. **Pull only** can fetch the public log without credentials. Decisions, comments, reviewer names and edit instructions become public when pushed.

For the repository owner, use a fine-grained token restricted to `tsackton/taeglar-art-review` with **Contents: Read and write**. An invited outside collaborator using a classic token for this public repository needs the `public_repo` scope. [GitHub’s guide to personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

## How sync works

Each change gets an immutable entry under `reviews/<image-id>/`. One sync downloads missing changes and sends local changes together in a Git commit. Two people can add notes to the same image independently. If they select competing versions, both proposals remain available for resolution in the gallery. Review responses refer to the proposal being reviewed.

The gallery saves changes in the current browser as you work. **Export decisions** downloads a portable backup. **Import decisions** restores a backup locally, and **Sync** shares the imported history. Reviewers who already used the gallery should open the updated page in the same browser at the same file location to carry their choices forward.

## Update another copy of the gallery

Copy the files inside `gallery/` into the existing `vault-restyle/` folder, then reload its `index.html`. The original catalog, inventory and generated artwork are supplied separately.

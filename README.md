# Taelgar art review

Open the illustrated catalog’s `vault-restyle` folder and double-click **Open Art Review.command** on macOS or **Open Art Review.cmd** on Windows. The gallery opens in your browser. Keep the launcher window open while reviewing. You can also run `python3 art_review.py` from that folder.

The launcher needs Python 3.9 or newer. To sync, install [GitHub CLI](https://cli.github.com/) and sign in once with `gh auth login`. Each collaborator uses their own account and needs write access to publish decisions. Choices, reviewer names, comments and edit instructions are visible in this public repository.

## Review an illustration

1. Enter your reviewer name and choose an original or a restyle. **Use with edits** lets you select an image and describe what needs fixing.
2. Use **Request review** to ask a collaborator to check your decision. Include your question in the review comment. You can also add an image note at any time.
3. To see a collaborator’s requests, click **Sync** and filter **Review** to **Needs review**. You can narrow the list by requester. Open an image in the lightbox, approve or reject the selection with a comment, and click **Sync** to share your response.

## Share and back up decisions

The browser saves your work as you go. **Sync** retrieves other reviewers’ changes and publishes yours. **Pull only** retrieves shared changes without publishing your local work. Each change has its own file under `reviews/<image-id>/`. Two people can add notes independently, even on the same image. If two reviewers make different selections, the gallery keeps both for resolution.

**Export decisions** downloads a backup of the choices and review history in your browser. **Import decisions** merges a backup into the current browser and skips entries it already has. Click **Sync** when you’re ready to share imported entries.

**Moving from the old HTML gallery?** Open the launcher and click **Pull only** for previously synced work. For choices you haven’t synced, open the old `index.html` directly in the browser and profile you used before, click **Export decisions**, then **Import decisions** in the new gallery.

## Update another copy of the catalog

Copy the files inside this repository’s `gallery/` folder into the illustrated catalog’s `vault-restyle/` folder, then reopen the launcher. Keep the catalog’s `originals/` and `thumbnails/` folders alongside `vault-restyle/`. The catalog inventory and artwork are distributed separately.

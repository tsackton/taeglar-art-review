# Taelgar art review

1. Download the **image-source** folder from the shared Dropbox link. If you downloaded a ZIP, unzip it.
2. Clone this repository anywhere on your computer.
3. Double-click **Open Art Review.cmd** on Windows or **Open Art Review.command** on Mac. The first time, select the folder you downloaded.

The launcher saves the folder path in a local file named `.image-source` inside your clone. Git ignores this file. Next time the gallery opens directly in your browser. Keep the launcher window open while reviewing. It requires Python 3.9 or newer.

## Review together

Enter your name, open an illustration, and choose a version. Choose **Use with edits** on a version to save it with instructions. When a decision takes an illustration out of the **Open** list, it stays on screen for notes and review. Choose **Next open image** when you’re ready to move on. **Request review** asks the other reviewer to check your choice. Use the **Needs review** filter to find requests and approve or reject them.

Click **Sync** to share your changes and get the other reviewer’s decisions. For sync, install GitHub CLI and sign in once with `gh auth login` using an account with write access to this repository. Synced notes and decisions are public. [GitHub CLI](https://cli.github.com/)

**Pull only** gets shared decisions. **Export decisions** saves a backup. **Import decisions** merges a backup into the gallery.

## Review edited images

Open **Art Review** with the usual launcher and switch to **Edited candidates**. Each finished set shows the selected starting image, the original edit instructions, and versions A, B, and C. Click an image for a full-size comparison. Choose a version, keep the starting image, or use **Use with edits** to request another change.

The edited set has its own decision. You can revisit the first-round choice in the same gallery. Reviewer names, comments, review requests, Sync, and decision backups work across both rounds. To see the edited artwork on another computer, place the matching `restyle-edits` folder next to the selected image-source folder. Sync shares decisions and comments. Artwork travels with the image folders.

After pulling new first-round reviews, run `node tools/prepare_edit_queue.js` to refresh the generation requests. The gallery picks up a completed set when all three PNG files (`1.png`, `2.png`, and `3.png`) are present under `restyle-edits/candidates/<item ID>/<request ID>/`. Reload the gallery to see newly finished sets.

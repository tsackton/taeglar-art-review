# Taelgar art review

1. Download the **image-source** folder from the shared Dropbox link. If you downloaded a ZIP, unzip it.
2. Clone this repository anywhere on your computer.
3. Double-click **Open Art Review.cmd** on Windows or **Open Art Review.command** on Mac. The first time, select the folder you downloaded.

The launcher saves the folder path in a local file named `.image-source` inside your clone. Git ignores this file. Next time the gallery opens directly in your browser. Keep the launcher window open while reviewing. It requires Python 3.9 or newer.

## Review together

Enter your name, open an illustration, and choose a version. Choose **Use with edits** on a version to save it with instructions. When a decision takes an illustration out of the **Open** list, it stays on screen for notes and review. Choose **Next open image** when you’re ready to move on. **Request review** asks the other reviewer to check your choice. Use the **Needs review** filter to find requests and approve or reject them.

Click **Sync** to share your changes and get the other reviewer’s decisions. For sync, install GitHub CLI and sign in once with `gh auth login` using an account with write access to this repository. Synced notes and decisions are public. [GitHub CLI](https://cli.github.com/)

**Pull only** gets shared decisions. **Export decisions** saves a backup. **Import decisions** merges a backup into the gallery.

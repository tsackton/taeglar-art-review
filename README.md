# Taelgar art review

Clone this repository anywhere. Keep the illustrated collection in its own folder, on your computer or a mounted drive.

With Python 3.9 or newer installed, double-click **Open Art Review.command** on macOS or **Open Art Review.cmd** on Windows. Choose your image source folder when prompted. The launcher remembers your choice and opens the gallery in your browser. If a folder named `image-source` sits beside the clone, the launcher finds it automatically.

You can also start the app with an explicit source, or use this command to switch collections after closing the launcher:

```sh
python3 art_review.py "/path/to/image source"
```

On Windows, use `py -3` in place of `python3`. Keep the launcher window open while you review.

## Review and share

- Open an illustration in the lightbox and choose the original or a restyle. **Use with edits** records the change you want made to your selection.
- Enter your reviewer name and choose **Request review** to ask a collaborator to check your decision. They can filter by **Needs review** and requester, then approve or reject with a comment.
- **Sync** pulls other reviewers’ changes and pushes yours using your GitHub CLI login. Sign in once with `gh auth login`. Publishing requires write access to this repository. Choices, reviewer names and comments are public when synced. [Install GitHub CLI](https://cli.github.com/)
- **Pull only** retrieves shared reviews. **Export decisions** saves a backup for this collection. **Import decisions** merges that backup into the current browser. Each change has its own file in `reviews/<projectId>/<image-id>/`, so collaborators can review the same image independently.

## Image source layout

Select the folder containing these files:

```text
inventory.json   # Collection ID and illustrations
outputs.json     # Restyles and QA results, keyed by illustration ID
originals/
thumbnails/
variants/
qa/
generation/
```

Image paths in both JSON files are relative to the selected folder. The gallery reads the manifests at startup and loads images as you browse. QA and generation material can travel with the collection. The gallery serves originals, thumbnails and variants.

Give each independent collection a unique `projectId` in `inventory.json`. Keep that ID when sharing a copy of the same collection so collaborators see the same reviews. A minimal portrait inventory looks like this:

```json
{
  "projectId": "my-campaign",
  "items": [{
    "id": "alesh",
    "label": "Alesh",
    "kind": "portrait",
    "source": "originals/alesh.png",
    "thumbnail": "thumbnails/alesh.jpg",
    "sha256": "<64-character SHA-256 of the original>",
    "notes": ["People/Alesh.md"]
  }]
}
```

Use `{}` for `outputs.json` if there are no restyles yet. To rebuild the restyle index from a collection’s per-image QA files, run `python3 tools/rebuild_outputs.py "/path/to/image source"`.

#!/bin/bash
PATH_DIR="${GITHUB_WORKSPACE}/${PATH_DIR}"
manifest_file="${GIT_MANIFEST}"
rsync_file="${RSYNC_MANIFEST}"

echo "--------------------------------------------------"

cd "${PATH_DIR}" || exit 1;

echo "Removing leading +/- from manifest file"
sed -i -E "s/^[+-] //" "$manifest_file"

echo "Removing leading 'deleting' from rsync file"
sed -i -E "s/^deleting //" "$rsync_file"

echo "Removing directories from rsync file"
sed -i -E "/\/$/d" "$rsync_file"

# if SSH_IGNORE_LIST is not empty
if [ -n "$SSH_IGNORE_LIST" ]; then

  # Process gitignore rules if they are not empty
  echo "Applying new Gitignore rules:"
  echo "${SSH_IGNORE_LIST}"

  # Popuplate new gitignore file with contents of $SSH_IGNORE_LIST
  mv .gitignore .gitignore.bak
  echo "$SSH_IGNORE_LIST" > .gitignore

  # Create a temporary file to store the updated file paths
  temp_file=$(mktemp)

  # Remove lines matching gitignore patterns from file_paths.txt
  while IFS= read -r file_path; do
      if ! git check-ignore -q --no-index "$file_path"; then
          echo "$file_path" >> "$temp_file"
      else
          echo "Removed line from GIT manifest: $file_path"
      fi
  done < "$manifest_file"

  # Overwrite the original file_paths.txt with the temporary file
  mv "$temp_file" "$manifest_file"

  # Revert .gitignore to original state
  mv -f .gitignore.bak .gitignore

fi

# Sort and remove empty lines from the files
sorted_file1=$(grep -v '^$' "$manifest_file" | sort)
sorted_file2=$(grep -v '^$' "$rsync_file" | sort)

# Compare the sorted files using diff
diff_output=$(diff -u <(echo "$sorted_file1") <(echo "$sorted_file2"))
echo "--------------------------------------------------"
# Check if there are any differences
if [ -n "$diff_output" ]; then
  echo "Manifest and Rsync list DO NOT MATCH. Please check the following diff. Lines starting with + are in the rsync list but not in the manifest. Lines starting with - are in the manifest but not in the rsync list."
  echo "--------------------------------------------------"
  echo "::group::DIFF OUTPUT"
  echo "$diff_output"
  echo "::endgroup::"
  exit 1
else
  echo "Manifest and Rsync list match."
  echo "--------------------------------------------------"
  exit 0
fi

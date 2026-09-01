# VERSION: v9 — clean UI + automatic rename actions + metadata-source dependencies
# BUILD: 2026-09-01-clean-ui-v9
import os
import re
import sys
import shutil
import queue
import threading
import subprocess
import datetime
import traceback

# Silence the warning emitted by Apple's legacy system Tk.
# v8 also avoids themed ttk widgets because they can render blank in macOS Dark Mode.
os.environ.setdefault("TK_SILENCE_DEPRECATION", "1")

import tkinter as tk
from tkinter import filedialog, messagebox
from tkinter.scrolledtext import ScrolledText


APP_TITLE = "Photo Rename & Metadata Tool v8"

IMAGE_EXTENSIONS = {
    '.jpg', '.jpeg', '.heic', '.png', '.dng', '.tif', '.tiff'
}
VIDEO_EXTENSIONS = {'.mov', '.mp4', '.m4v'}
SUPPORTED_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS


# ============================================================
# Filename / matching helpers
# ============================================================

def strip_date_prefix(name):
    """Remove one leading YYYYMMDD- prefix before matching/renaming."""
    return re.sub(r'^\d{8}-', '', name)


def convert_be_date_prefix(name):
    """
    Convert a leading Buddhist Era YYYYMMDD- prefix to C.E.

    Example:
        25671221-IMG_4697.JPG -> 20241221-IMG_4697.JPG

    Returns:
        (new_name, detected_be_prefix)
    """
    match = re.match(r'^(\d{4})(\d{2})(\d{2})-(.+)$', name)
    if not match:
        return name, False

    be_year = int(match.group(1))
    month = int(match.group(2))
    day = int(match.group(3))
    remainder = match.group(4)

    # Guard against normal C.E. names such as 20250104-IMG_0415.HEIC.
    if not 2400 <= be_year <= 2999:
        return name, False

    ce_year = be_year - 543
    try:
        datetime.date(ce_year, month, day)
    except ValueError:
        return name, False

    return f"{ce_year:04d}{month:02d}{day:02d}-{remainder}", True


def normalize_filename(name):
    """Normalize a filename for same-base grouping / Live Photo detection."""
    clean = strip_date_prefix(name)
    base = os.path.splitext(clean)[0].lower()
    base = re.sub(r'-\d+$', '', base)
    return base


def get_extension(name):
    return os.path.splitext(name)[1].lower()


def iphone_sequence_key(name):
    """
    Return a conservative iPhone filename sequence key such as IMG_0415.

    Date prefixes are ignored, so these all return IMG_0415:
        IMG_0415.HEIC
        IMG_0415_Original.jpg
        20250104-IMG_0415_Original.jpg
        20250104-IMG_0415-edit.jpg

    The sequence must be at the beginning after an optional date prefix, and
    the 4 digits must end the stem or be followed by a common separator.
    """
    clean = strip_date_prefix(os.path.basename(name))
    stem = os.path.splitext(clean)[0]
    match = re.match(r'^(IMG)_(\d{4})(?=$|[_\-\s(])', stem, re.IGNORECASE)
    if not match:
        return None
    return f"IMG_{match.group(2)}"


def is_canonical_iphone_original(name):
    """True for exact IMG_#### names, allowing an optional YYYYMMDD- prefix."""
    clean = strip_date_prefix(os.path.basename(name))
    stem = os.path.splitext(clean)[0]
    return re.fullmatch(r'IMG_\d{4}', stem, re.IGNORECASE) is not None


def source_extension_priority(ext):
    """Prefer native/high-information iPhone still-image originals."""
    order = {
        '.heic': 0,
        '.dng': 1,
        '.jpg': 2,
        '.jpeg': 2,
        '.tif': 3,
        '.tiff': 3,
        '.png': 4,
    }
    return order.get(ext.lower(), 99)


# ============================================================
# Tool discovery / metadata helpers
# ============================================================

def find_executable(name, common_paths=()):
    path = shutil.which(name)
    if path:
        return path
    for candidate in common_paths:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def find_exiftool():
    # GUI apps launched outside a shell may not inherit Homebrew's PATH.
    return find_executable(
        'exiftool',
        (
            '/opt/homebrew/bin/exiftool',
            '/usr/local/bin/exiftool',
            '/usr/bin/exiftool',
        )
    )


def find_setfile():
    path = find_executable(
        'SetFile',
        (
            '/usr/bin/SetFile',
            '/Developer/Tools/SetFile',
        )
    )
    if path:
        return path

    try:
        result = subprocess.run(
            ['xcrun', '--find', 'SetFile'],
            capture_output=True,
            text=True,
            check=False,
        )
        candidate = result.stdout.strip()
        if result.returncode == 0 and candidate and os.path.isfile(candidate):
            return candidate
    except OSError:
        pass
    return None


def parse_exiftool_datetime(value):
    """Parse common ExifTool date output into a naive local datetime."""
    value = value.strip()
    match = re.match(
        r'^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})',
        value,
    )
    if not match:
        return None

    try:
        return datetime.datetime(
            int(match.group(1)),
            int(match.group(2)),
            int(match.group(3)),
            int(match.group(4)),
            int(match.group(5)),
            int(match.group(6)),
        )
    except ValueError:
        return None


def get_embedded_capture_date(path, exiftool_path):
    """
    Read capture/creation date from embedded metadata.

    Priority is intentionally capture-centric, because this is what should drive
    the YYYYMMDD photo prefix when an authoritative original is available.
    """
    if not exiftool_path:
        return None

    tags = [
        '-DateTimeOriginal',
        '-CreateDate',
        '-MediaCreateDate',
        '-TrackCreateDate',
    ]

    try:
        result = subprocess.run(
            [exiftool_path, '-s3', *tags, path],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None

    if result.returncode != 0:
        return None

    for line in result.stdout.splitlines():
        dt = parse_exiftool_datetime(line)
        if dt:
            return dt
    return None


def get_spotlight_created_date(path):
    try:
        result = subprocess.run(
            ['mdls', '-raw', '-name', 'kMDItemContentCreationDate', path],
            capture_output=True,
            text=True,
            check=False,
        )
        value = result.stdout.strip()
        if result.returncode == 0 and value and value != '(null)':
            dt = datetime.datetime.strptime(value, '%Y-%m-%d %H:%M:%S %z')
            return dt.astimezone().replace(tzinfo=None)
    except (OSError, ValueError):
        pass
    return None


def get_filesystem_birth_date(path):
    try:
        stat = os.stat(path)
        birth_time = getattr(stat, 'st_birthtime', None)
        if birth_time is not None:
            return datetime.datetime.fromtimestamp(birth_time)
    except OSError:
        pass
    return None


def get_best_created_date(path, exiftool_path):
    """
    Best date for photo naming / source synchronization.

    Priority:
      1. Embedded capture/create date
      2. Spotlight content creation date
      3. macOS filesystem birth date
    """
    return (
        get_embedded_capture_date(path, exiftool_path)
        or get_spotlight_created_date(path)
        or get_filesystem_birth_date(path)
    )


def copy_embedded_metadata(source_path, target_path, exiftool_path):
    """
    Copy writable EXIF/XMP/IPTC/GPS/date/camera metadata from source to target.

    Binary/rendering-specific tags are excluded so a converted JPEG does not
    inherit misleading dimensions, previews, orientation, or a source color
    profile that belongs to the HEIC/DNG pixel data.
    """
    command = [
        exiftool_path,
        '-overwrite_original_in_place',
        '-P',
        '-TagsFromFile', source_path,
        '-all:all',
        '--FileName',
        '--Directory',
        '--FileSize',
        '--FileType',
        '--FileTypeExtension',
        '--MIMEType',
        '--ImageWidth',
        '--ImageHeight',
        '--ExifImageWidth',
        '--ExifImageHeight',
        '--Orientation',
        '--ThumbnailImage',
        '--PreviewImage',
        '--JpgFromRaw',
        '--ICC_Profile:All',
        target_path,
    ]

    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as exc:
        return False, str(exc)

    if result.returncode != 0:
        message = (result.stderr or result.stdout or 'ExifTool failed').strip()
        return False, message

    return True, ''


def set_filesystem_dates(path, dt, setfile_path):
    """Best-effort macOS Created + Modified date sync."""
    if not dt:
        return False, 'source capture/created date unavailable'

    warnings = []
    modified_ok = False

    try:
        result = subprocess.run(
            ['touch', '-t', dt.strftime('%Y%m%d%H%M.%S'), path],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            modified_ok = True
        else:
            warnings.append((result.stderr or result.stdout or 'touch failed').strip())
    except OSError as exc:
        warnings.append(f'touch: {exc}')

    if not setfile_path:
        warnings.append('SetFile not found; Finder Created date was not changed')
        return False, '; '.join(warnings)

    try:
        setfile_time = dt.strftime('%m/%d/%Y %H:%M:%S')
        result = subprocess.run(
            [setfile_path, '-d', setfile_time, '-m', setfile_time, path],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            warnings.append((result.stderr or result.stdout or 'SetFile failed').strip())
    except OSError as exc:
        warnings.append(f'SetFile: {exc}')

    return modified_ok and not warnings, '; '.join(warnings)


# ============================================================
# Scanning / source matching
# ============================================================

def scan_folder(folder, recursive=False):
    """Return file records. Target scanning is normally non-recursive."""
    records = []

    if recursive:
        iterator = (
            os.path.join(root, filename)
            for root, dirs, files in os.walk(folder)
            for filename in files
        )
    else:
        iterator = (
            os.path.join(folder, filename)
            for filename in os.listdir(folder)
        )

    for path in iterator:
        try:
            if not os.path.isfile(path):
                continue
            filename = os.path.basename(path)
            if filename.startswith('.'):
                continue
            ext = get_extension(filename)
            if ext not in SUPPORTED_EXTENSIONS:
                continue
            records.append({
                'filename': filename,
                'path': path,
                'ext': ext,
                'size': os.path.getsize(path),
            })
        except OSError:
            continue

    return records


def build_source_index(source_records):
    """
    Build IMG_#### -> authoritative source path using exact canonical originals.

    A source may itself already have a YYYYMMDD- prefix. If two equally-good
    originals exist for one key, that key is marked ambiguous rather than guessed.
    """
    candidates_by_key = {}

    for item in source_records:
        if item['ext'] not in IMAGE_EXTENSIONS:
            continue
        key = iphone_sequence_key(item['filename'])
        if not key or not is_canonical_iphone_original(item['filename']):
            continue
        candidates_by_key.setdefault(key, []).append(item)

    source_by_key = {}
    ambiguous = []

    for key, candidates in candidates_by_key.items():
        best_priority = min(source_extension_priority(x['ext']) for x in candidates)
        best = [x for x in candidates if source_extension_priority(x['ext']) == best_priority]

        if len(best) == 1:
            source_by_key[key] = best[0]
        else:
            ambiguous.append({
                'key': key,
                'sources': [x['path'] for x in best],
            })

    return source_by_key, ambiguous


def match_targets_to_sources(target_records, source_by_key):
    """Match image targets to one confident canonical source by IMG_####."""
    result = {}
    for target in target_records:
        if target['ext'] not in IMAGE_EXTENSIONS:
            continue
        key = iphone_sequence_key(target['filename'])
        if not key:
            continue
        source = source_by_key.get(key)
        if not source:
            continue
        try:
            if os.path.samefile(target['path'], source['path']):
                continue
        except OSError:
            if os.path.abspath(target['path']) == os.path.abspath(source['path']):
                continue
        result[target['path']] = source['path']
    return result


# ============================================================
# Main processing engine
# ============================================================

def process_job(config, emit):
    """Run one preview/live job. All UI interaction happens through emit()."""
    dry_run = config['dry_run']
    target_folder = config['target_folder']
    source_folder = config.get('source_folder') or ''

    enable_rename = config['enable_rename']
    enable_date_prefix = config['enable_date_prefix']
    enable_be_to_ce = config['enable_be_to_ce']
    enable_move_live = config['enable_move_live']
    enable_source_match = config['enable_source_match']
    enable_metadata_copy = config['enable_metadata_copy']
    enable_fs_dates = config['enable_fs_dates']
    recursive_source = config['recursive_source']

    conflict_folder = os.path.join(target_folder, 'Conflicts')
    live_photo_folder = os.path.join(target_folder, 'LivePhotos')

    exiftool_path = find_exiftool()
    setfile_path = find_setfile()

    emit('status', 'Scanning target folder…')
    target_records = scan_folder(target_folder, recursive=False)

    source_records = []
    source_by_key = {}
    ambiguous_sources = []
    matched_source_by_target = {}

    if enable_source_match:
        emit('status', 'Scanning metadata source folder…')
        source_records = scan_folder(source_folder, recursive=recursive_source)
        source_by_key, ambiguous_sources = build_source_index(source_records)
        matched_source_by_target = match_targets_to_sources(target_records, source_by_key)

    # Cache source dates before any target rename/move. This also makes matching
    # work when target files already have YYYYMMDD- prefixes.
    matched_source_date = {}
    if matched_source_by_target:
        emit('status', 'Reading dates from matched originals…')
        items = list(matched_source_by_target.items())
        for idx, (target_path, source_path) in enumerate(items, 1):
            matched_source_date[target_path] = get_best_created_date(source_path, exiftool_path)
            emit('progress', idx, max(len(items), 1), 'Reading source metadata')

    groups = {}
    for item in target_records:
        groups.setdefault(normalize_filename(item['filename']), []).append(item)

    # Counters / exceptions
    stats = {
        'target_files': len(target_records),
        'source_files': len(source_records),
        'groups': len(groups),
        'matched_targets': len(matched_source_by_target),
        'ambiguous_sources': len(ambiguous_sources),
        'source_date_used': 0,
        'needs_rename': 0,
        'rename_actions': 0,
        'be_detected': 0,
        'be_actions': 0,
        'already_ok': 0,
        'metadata_actions': 0,
        'metadata_failures': 0,
        'fs_date_actions': 0,
        'fs_date_warnings': 0,
        'live_groups': 0,
        'live_video_actions': 0,
        'live_video_skipped': 0,
        'conflict_groups': 0,
        'conflict_file_actions': 0,
        'missing_date': 0,
        'name_collision_skips': 0,
    }

    missing_dates = []
    conflicts = []
    ambiguous_details = ambiguous_sources[:]
    metadata_errors = []
    fs_warnings = []
    live_skips = []
    rename_collisions = []

    # Metadata update is deliberately independent of rename. This supports:
    #   20250104-IMG_0415_Original.jpg  <-  IMG_0415.HEIC
    # even when Rename is OFF and the target was renamed on a previous run.
    if enable_source_match and (enable_metadata_copy or enable_fs_dates):
        matched_items = list(matched_source_by_target.items())
        for idx, (target_path, source_path) in enumerate(matched_items, 1):
            source_dt = matched_source_date.get(target_path)

            if enable_metadata_copy:
                if dry_run:
                    if exiftool_path:
                        stats['metadata_actions'] += 1
                    else:
                        stats['metadata_failures'] += 1
                        metadata_errors.append({
                            'target': target_path,
                            'source': source_path,
                            'error': 'ExifTool not found',
                        })
                else:
                    if not exiftool_path:
                        stats['metadata_failures'] += 1
                        metadata_errors.append({
                            'target': target_path,
                            'source': source_path,
                            'error': 'ExifTool not found',
                        })
                    else:
                        ok, error = copy_embedded_metadata(source_path, target_path, exiftool_path)
                        if ok:
                            stats['metadata_actions'] += 1
                        else:
                            stats['metadata_failures'] += 1
                            metadata_errors.append({
                                'target': target_path,
                                'source': source_path,
                                'error': error,
                            })

            if enable_fs_dates:
                if source_dt:
                    if dry_run:
                        stats['fs_date_actions'] += 1
                    else:
                        ok, warning = set_filesystem_dates(target_path, source_dt, setfile_path)
                        if ok:
                            stats['fs_date_actions'] += 1
                        else:
                            stats['fs_date_warnings'] += 1
                            fs_warnings.append({
                                'target': target_path,
                                'warning': warning,
                            })
                else:
                    stats['fs_date_warnings'] += 1
                    fs_warnings.append({
                        'target': target_path,
                        'warning': 'matched source has no readable capture/created date',
                    })

            emit('progress', idx, max(len(matched_items), 1), 'Copying/syncing metadata')

    total_groups = max(len(groups), 1)

    for group_index, (normalized, files) in enumerate(groups.items(), 1):
        sizes = {f['size'] for f in files}
        exts = {f['ext'] for f in files}
        has_image = any(ext in IMAGE_EXTENSIONS for ext in exts)
        has_video = any(ext in VIDEO_EXTENSIONS for ext in exts)
        is_live_photo = has_image and has_video
        is_conflict = len(sizes) > 1 and not is_live_photo

        if is_conflict:
            stats['conflict_groups'] += 1
            conflicts.append({
                'group': normalized,
                'files': [f['filename'] for f in files],
            })

            for f in files:
                dst = os.path.join(conflict_folder, f['filename'])
                if dry_run:
                    stats['conflict_file_actions'] += 1
                else:
                    os.makedirs(conflict_folder, exist_ok=True)
                    if os.path.exists(dst):
                        # Do not overwrite an existing conflict file.
                        continue
                    shutil.move(f['path'], dst)
                    stats['conflict_file_actions'] += 1

            emit('progress', group_index, total_groups, 'Processing files')
            continue

        if is_live_photo:
            stats['live_groups'] += 1

        processed_files = []

        for f in files:
            filename = f['filename']
            working_filename = filename
            be_detected = False

            if enable_be_to_ce:
                working_filename, be_detected = convert_be_date_prefix(filename)
                if be_detected:
                    stats['be_detected'] += 1

            created_dt = None
            if enable_date_prefix:
                source_dt = matched_source_date.get(f['path']) if enable_source_match else None
                if source_dt:
                    created_dt = source_dt
                    stats['source_date_used'] += 1
                else:
                    created_dt = get_best_created_date(f['path'], exiftool_path)

                if created_dt:
                    date_prefix = created_dt.strftime('%Y%m%d')
                else:
                    date_prefix = 'UNSORTED'
                    stats['missing_date'] += 1
                    missing_dates.append(filename)

                clean_filename = strip_date_prefix(working_filename)
                new_name = f'{date_prefix}-{clean_filename}'
            else:
                new_name = working_filename

            needs_rename = new_name != filename
            if needs_rename:
                stats['needs_rename'] += 1
            else:
                stats['already_ok'] += 1

            if be_detected and needs_rename and enable_rename:
                stats['be_actions'] += 1

            if needs_rename and enable_rename:
                current_name = new_name
            else:
                current_name = filename

            current_path = os.path.join(target_folder, current_name)

            if needs_rename and enable_rename:
                if dry_run:
                    # Preview collision exactly as live mode would see it.
                    if current_path != f['path'] and os.path.exists(current_path):
                        stats['name_collision_skips'] += 1
                        rename_collisions.append({
                            'source': f['path'],
                            'destination': current_path,
                        })
                        current_name = filename
                        current_path = f['path']
                    else:
                        stats['rename_actions'] += 1
                else:
                    if current_path != f['path'] and os.path.exists(current_path):
                        stats['name_collision_skips'] += 1
                        rename_collisions.append({
                            'source': f['path'],
                            'destination': current_path,
                        })
                        current_name = filename
                        current_path = f['path']
                    else:
                        os.rename(f['path'], current_path)
                        stats['rename_actions'] += 1
            else:
                current_path = f['path']
                current_name = filename

            processed_files.append({
                'name': current_name,
                'path': current_path,
                'ext': f['ext'],
            })

        if is_live_photo and enable_move_live:
            for item in processed_files:
                if item['ext'] not in VIDEO_EXTENSIONS:
                    continue
                dst = os.path.join(live_photo_folder, item['name'])

                if dry_run:
                    if os.path.exists(dst):
                        stats['live_video_skipped'] += 1
                        live_skips.append(dst)
                    else:
                        stats['live_video_actions'] += 1
                else:
                    os.makedirs(live_photo_folder, exist_ok=True)
                    if os.path.exists(dst):
                        stats['live_video_skipped'] += 1
                        live_skips.append(dst)
                    else:
                        shutil.move(item['path'], dst)
                        stats['live_video_actions'] += 1

        emit('progress', group_index, total_groups, 'Processing files')

    mode = 'DRY RUN / PREVIEW' if dry_run else 'COMPLETED'
    rename_label = 'Would rename' if dry_run else 'Renamed'
    meta_label = 'Would copy source metadata' if dry_run else 'Copied source metadata'
    fs_label = 'Would sync Finder dates' if dry_run else 'Synced Finder dates'
    live_label = 'Would move LivePhoto videos' if dry_run else 'Moved LivePhoto videos'
    conflict_label = 'Would move conflict files' if dry_run else 'Moved conflict files'
    be_label = 'Would convert B.E. prefixes' if dry_run else 'Converted B.E. prefixes'

    lines = []
    lines.append('================ PLAN / RESULT SUMMARY ================')
    lines.append(f'Mode                         : {mode}')
    lines.append(f'Target folder                : {target_folder}')
    lines.append(f'Metadata source folder       : {source_folder if enable_source_match else "(disabled)"}')
    lines.append(f'ExifTool                     : {exiftool_path or "NOT FOUND"}')
    lines.append(f'SetFile                      : {setfile_path or "NOT FOUND"}')
    lines.append('-------------------------------------------------------')
    lines.append(f'Date prefix                  : {"YES" if enable_date_prefix else "NO"}')
    lines.append(f'B.E. -> C.E.                 : {"YES" if enable_be_to_ce else "NO"}')
    lines.append(f'Move LivePhoto videos        : {"YES" if enable_move_live else "NO"}')
    lines.append(f'Original metadata matching  : {"AUTO" if enable_source_match else "OFF"}')
    lines.append(f'Copy matched metadata        : {"YES" if enable_metadata_copy else "NO"}')
    lines.append(f'Sync Finder dates            : {"YES" if enable_fs_dates else "NO"}')
    lines.append(f'Recursive source search      : {"YES" if recursive_source else "NO"}')
    lines.append('-------------------------------------------------------')
    lines.append(f'Target files scanned         : {stats["target_files"]}')
    lines.append(f'Source files scanned         : {stats["source_files"]}')
    lines.append(f'Groups processed             : {stats["groups"]}')
    lines.append(f'Confident source matches     : {stats["matched_targets"]}')
    lines.append(f'Ambiguous source keys        : {stats["ambiguous_sources"]}')
    lines.append(f'Source date used for naming  : {stats["source_date_used"]}')
    lines.append(f'{meta_label:<29}: {stats["metadata_actions"]}')
    lines.append(f'Metadata copy failures       : {stats["metadata_failures"]}')
    lines.append(f'{fs_label:<29}: {stats["fs_date_actions"]}')
    lines.append(f'Finder date warnings         : {stats["fs_date_warnings"]}')
    lines.append(f'Needs rename                 : {stats["needs_rename"]}')
    lines.append(f'B.E. prefixes detected       : {stats["be_detected"]}')
    lines.append(f'{be_label:<29}: {stats["be_actions"]}')
    lines.append(f'{rename_label:<29}: {stats["rename_actions"]}')
    lines.append(f'Already correctly named      : {stats["already_ok"]}')
    lines.append(f'Rename collisions skipped    : {stats["name_collision_skips"]}')
    lines.append(f'Live Photo groups            : {stats["live_groups"]}')
    lines.append(f'{live_label:<29}: {stats["live_video_actions"]}')
    lines.append(f'Skipped LivePhoto videos     : {stats["live_video_skipped"]}')
    lines.append(f'Conflict groups              : {stats["conflict_groups"]}')
    lines.append(f'{conflict_label:<29}: {stats["conflict_file_actions"]}')
    lines.append(f'Missing capture/Created Date : {stats["missing_date"]}')
    lines.append('=======================================================')

    if dry_run:
        lines.append('')
        lines.append('PREVIEW ONLY — no files were changed.')

    if ambiguous_details:
        lines.append('')
        lines.append('AMBIGUOUS IMG_#### SOURCES — SKIPPED')
        for item in ambiguous_details:
            lines.append(f'  {item["key"]}')
            for path in item['sources']:
                lines.append(f'    - {path}')

    if metadata_errors:
        lines.append('')
        lines.append('METADATA COPY ERRORS')
        for item in metadata_errors:
            lines.append(
                f'  - {os.path.basename(item["target"])} <- '
                f'{os.path.basename(item["source"])}: {item["error"]}'
            )

    if fs_warnings:
        lines.append('')
        lines.append('FINDER DATE WARNINGS')
        for item in fs_warnings:
            lines.append(f'  - {os.path.basename(item["target"])}: {item["warning"]}')

    if missing_dates:
        lines.append('')
        lines.append('MISSING CAPTURE / CREATED DATE')
        for name in missing_dates:
            lines.append(f'  - {name}')

    if rename_collisions:
        lines.append('')
        lines.append('RENAME COLLISIONS — SKIPPED')
        for item in rename_collisions:
            lines.append(
                f'  - {os.path.basename(item["source"])} -> '
                f'{os.path.basename(item["destination"])}'
            )

    if live_skips:
        lines.append('')
        lines.append('LIVE PHOTO VIDEO DESTINATIONS ALREADY EXIST')
        for path in live_skips:
            lines.append(f'  - {path}')

    if conflicts:
        lines.append('')
        lines.append('CONFLICT GROUPS')
        for item in conflicts:
            lines.append(f'  - {item["group"]}: {", ".join(item["files"])}')

    emit('summary', '\n'.join(lines))
    emit('progress', 1, 1, 'Done')


# ============================================================
# Tkinter GUI
# ============================================================

# Apple\'s /usr/bin/python3 can be linked to an old Aqua Tk.  On newer macOS
# releases, especially in Dark Mode, ttk controls may exist but draw as an
# empty dark window.  Use classic Tk widgets with an explicit palette here so
# the UI remains visible even with the system Python/Tk combination.
UI_BG = '#f2f2f2'
UI_PANEL = '#f7f7f7'
UI_FG = '#202020'
UI_MUTED = '#606060'
UI_ENTRY_BG = '#ffffff'
UI_BORDER = '#b8b8b8'
UI_PROGRESS_BG = '#d6d6d6'
UI_PROGRESS_FG = '#4a90e2'


class SimpleProgress(tk.Canvas):
    """Tiny progress bar that does not depend on ttk themes."""

    def __init__(self, master, height=16, **kwargs):
        super().__init__(
            master,
            height=height,
            background=UI_PROGRESS_BG,
            highlightbackground=UI_BORDER,
            highlightthickness=1,
            bd=0,
            **kwargs,
        )
        self._value = 0.0
        self.bind('<Configure>', lambda _event: self._redraw())

    def __setitem__(self, key, value):
        if key == 'value':
            self.set(value)
            return
        super().__setitem__(key, value)

    def set(self, value):
        try:
            self._value = max(0.0, min(100.0, float(value)))
        except (TypeError, ValueError):
            self._value = 0.0
        self._redraw()

    def _redraw(self):
        self.delete('progress_fill')
        width = max(0, self.winfo_width() - 2)
        height = max(0, self.winfo_height() - 2)
        fill_width = int(width * self._value / 100.0)
        if fill_width > 0 and height > 0:
            self.create_rectangle(
                1, 1, 1 + fill_width, 1 + height,
                outline='', fill=UI_PROGRESS_FG,
                tags='progress_fill',
            )


class RenameMetadataApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_TITLE)
        self.geometry('940x800')
        self.minsize(840, 700)
        self.configure(background=UI_BG)

        self.events = queue.Queue()
        self.worker = None

        self.target_var = tk.StringVar()
        self.source_var = tk.StringVar()

        self.date_prefix_var = tk.BooleanVar(value=True)
        self.be_to_ce_var = tk.BooleanVar(value=True)
        self.move_live_var = tk.BooleanVar(value=True)

        self.metadata_copy_var = tk.BooleanVar(value=True)
        self.fs_dates_var = tk.BooleanVar(value=True)
        self.recursive_source_var = tk.BooleanVar(value=True)

        self.status_var = tk.StringVar(value='Choose folders and options, then Preview or Run for Real.')

        self._build_ui()
        self._update_metadata_source_state()
        self.metadata_copy_var.trace_add('write', lambda *_: self._update_metadata_source_state())
        self.fs_dates_var.trace_add('write', lambda *_: self._update_metadata_source_state())
        self.after(100, self._poll_events)

    @staticmethod
    def _label(parent, text='', **kwargs):
        return tk.Label(parent, text=text, background=UI_PANEL, foreground=UI_FG, **kwargs)

    @staticmethod
    def _button(parent, text, command):
        return tk.Button(
            parent,
            text=text,
            command=command,
            background=UI_ENTRY_BG,
            foreground=UI_FG,
            activebackground='#e5e5e5',
            activeforeground=UI_FG,
            relief='raised',
            borderwidth=1,
            highlightthickness=0,
            padx=10,
            pady=3,
        )

    @staticmethod
    def _check(parent, text, variable):
        return tk.Checkbutton(
            parent,
            text=text,
            variable=variable,
            background=UI_PANEL,
            foreground=UI_FG,
            activebackground=UI_PANEL,
            activeforeground=UI_FG,
            selectcolor=UI_ENTRY_BG,
            highlightthickness=0,
            anchor='w',
        )

    def _build_ui(self):
        outer = tk.Frame(self, background=UI_BG, padx=20, pady=18)
        outer.pack(fill='both', expand=True)

        header = tk.Frame(outer, background=UI_BG)
        header.pack(fill='x')
        tk.Label(
            header,
            text=APP_TITLE,
            font=('Helvetica', 18, 'bold'),
            background=UI_BG,
            foreground=UI_FG,
            anchor='w',
        ).pack(fill='x')
        tk.Label(
            header,
            text='Rename photos, organize Live Photo videos, and restore metadata from originals.',
            font=('Helvetica', 11),
            background=UI_BG,
            foreground=UI_MUTED,
            anchor='w',
        ).pack(fill='x', pady=(2, 14))

        # Target folder — always required because every operation acts on it.
        target = tk.LabelFrame(
            outer,
            text='1. Target Folder',
            background=UI_PANEL,
            foreground=UI_FG,
            padx=12,
            pady=10,
            highlightbackground=UI_BORDER,
            highlightthickness=1,
        )
        target.pack(fill='x')
        target.columnconfigure(0, weight=1)

        tk.Label(
            target,
            text='Files to rename, move, or update',
            background=UI_PANEL,
            foreground=UI_MUTED,
            anchor='w',
        ).grid(row=0, column=0, columnspan=2, sticky='w', pady=(0, 5))

        self.target_entry = tk.Entry(
            target,
            textvariable=self.target_var,
            background=UI_ENTRY_BG,
            foreground=UI_FG,
            insertbackground=UI_FG,
            relief='sunken',
            borderwidth=1,
        )
        self.target_entry.grid(row=1, column=0, sticky='ew', ipady=4)
        self.target_browse = self._button(target, 'Choose Target Folder…', self._browse_target)
        self.target_browse.grid(row=1, column=1, padx=(10, 0))

        # Rename / organize actions. No master Rename checkbox: selecting an
        # individual filename option is enough to perform that rename.
        actions = tk.LabelFrame(
            outer,
            text='2. Rename & Organize',
            background=UI_PANEL,
            foreground=UI_FG,
            padx=12,
            pady=10,
            highlightbackground=UI_BORDER,
            highlightthickness=1,
        )
        actions.pack(fill='x', pady=(12, 0))

        self._check(
            actions,
            'Add / refresh YYYYMMDD- from capture / Created Date',
            self.date_prefix_var,
        ).pack(anchor='w', pady=2)
        self._check(
            actions,
            'Convert Buddhist Era YYYYMMDD- to C.E.  (25671221 → 20241221)',
            self.be_to_ce_var,
        ).pack(anchor='w', pady=2)
        self._check(
            actions,
            'Move only Live Photo videos to LivePhotos/',
            self.move_live_var,
        ).pack(anchor='w', pady=2)

        # Metadata options + their source folder in the same section.
        metadata = tk.LabelFrame(
            outer,
            text='3. Metadata from Originals',
            background=UI_PANEL,
            foreground=UI_FG,
            padx=12,
            pady=10,
            highlightbackground=UI_BORDER,
            highlightthickness=1,
        )
        metadata.pack(fill='x', pady=(12, 0))
        metadata.columnconfigure(0, weight=1)

        tk.Label(
            metadata,
            text='Matching is automatic by IMG_#### and ignores a leading YYYYMMDD-.',
            background=UI_PANEL,
            foreground=UI_MUTED,
            anchor='w',
        ).grid(row=0, column=0, columnspan=3, sticky='w', pady=(0, 6))

        self.metadata_copy_check = self._check(
            metadata,
            'Copy EXIF / XMP / IPTC + GPS / location + capture dates',
            self.metadata_copy_var,
        )
        self.metadata_copy_check.grid(row=1, column=0, columnspan=3, sticky='w', pady=2)

        self.fs_dates_check = self._check(
            metadata,
            'Sync Finder Created + Modified dates from original',
            self.fs_dates_var,
        )
        self.fs_dates_check.grid(row=2, column=0, columnspan=3, sticky='w', pady=2)

        self.source_label = tk.Label(
            metadata,
            text='Metadata Source Folder  —  originals to read from',
            background=UI_PANEL,
            foreground=UI_FG,
            font=('Helvetica', 11, 'bold'),
            anchor='w',
        )
        self.source_label.grid(row=3, column=0, columnspan=3, sticky='w', pady=(9, 4))

        self.source_entry = tk.Entry(
            metadata,
            textvariable=self.source_var,
            background=UI_ENTRY_BG,
            foreground=UI_FG,
            insertbackground=UI_FG,
            relief='sunken',
            borderwidth=1,
        )
        self.source_entry.grid(row=4, column=0, sticky='ew', ipady=4)

        self.source_browse = self._button(metadata, 'Choose Metadata Source…', self._browse_source)
        self.source_browse.grid(row=4, column=1, padx=(10, 0))

        self.source_target_btn = self._button(metadata, 'Use Target Folder', self._source_use_target)
        self.source_target_btn.grid(row=4, column=2, padx=(8, 0))

        self.recursive_source_check = self._check(
            metadata,
            'Search Metadata Source subfolders',
            self.recursive_source_var,
        )
        self.recursive_source_check.grid(row=5, column=0, columnspan=3, sticky='w', pady=(5, 0))

        self.source_hint = tk.Label(
            metadata,
            text='Source controls are disabled when both metadata update options are off.',
            background=UI_PANEL,
            foreground=UI_MUTED,
            anchor='w',
        )
        self.source_hint.grid(row=6, column=0, columnspan=3, sticky='w', pady=(2, 0))

        run = tk.LabelFrame(
            outer,
            text='4. Preview & Run',
            background=UI_PANEL,
            foreground=UI_FG,
            padx=12,
            pady=10,
            highlightbackground=UI_BORDER,
            highlightthickness=1,
        )
        run.pack(fill='x', pady=(12, 0))

        self.progress = SimpleProgress(run)
        self.progress.pack(fill='x', pady=(0, 5))
        tk.Label(
            run,
            textvariable=self.status_var,
            background=UI_PANEL,
            foreground=UI_MUTED,
            anchor='w',
        ).pack(fill='x', pady=(0, 8))

        buttons = tk.Frame(run, background=UI_PANEL)
        buttons.pack(fill='x')
        self.preview_btn = self._button(buttons, 'Preview / Dry Run', lambda: self._start_job(True))
        self.preview_btn.pack(side='left')
        self.run_btn = self._button(buttons, 'Run for Real', lambda: self._start_job(False))
        self.run_btn.pack(side='left', padx=(8, 0))
        self.clear_btn = self._button(buttons, 'Clear Summary', self._clear_summary)
        self.clear_btn.pack(side='right')

        result = tk.LabelFrame(
            outer,
            text='Summary / Exceptions',
            background=UI_PANEL,
            foreground=UI_FG,
            padx=8,
            pady=8,
            highlightbackground=UI_BORDER,
            highlightthickness=1,
        )
        result.pack(fill='both', expand=True, pady=(12, 0))

        self.summary = ScrolledText(
            result,
            wrap='none',
            height=12,
            font=('Menlo', 11),
            background=UI_ENTRY_BG,
            foreground=UI_FG,
            insertbackground=UI_FG,
            relief='sunken',
            borderwidth=1,
        )
        self.summary.pack(fill='both', expand=True)
        self.summary.configure(state='disabled')

    def _metadata_update_enabled(self):
        return self.metadata_copy_var.get() or self.fs_dates_var.get()

    def _update_metadata_source_state(self):
        enabled = self._metadata_update_enabled()
        state = 'normal' if enabled else 'disabled'

        for widget in (
            self.source_entry,
            self.source_browse,
            self.source_target_btn,
            self.recursive_source_check,
        ):
            widget.configure(state=state)

    def _browse_target(self):
        initial = self.target_var.get() or os.path.expanduser('~/Pictures')
        folder = filedialog.askdirectory(title='Choose Target Folder', initialdir=initial)
        if folder:
            self.target_var.set(folder)

    def _browse_source(self):
        initial = self.source_var.get() or self.target_var.get() or os.path.expanduser('~/Pictures')
        folder = filedialog.askdirectory(title='Choose Metadata Source Folder', initialdir=initial)
        if folder:
            self.source_var.set(folder)

    def _source_use_target(self):
        if self.target_var.get():
            self.source_var.set(self.target_var.get())

    def _clear_summary(self):
        self.summary.configure(state='normal')
        self.summary.delete('1.0', 'end')
        self.summary.configure(state='disabled')

    def _append_summary(self, text):
        self.summary.configure(state='normal')
        self.summary.delete('1.0', 'end')
        self.summary.insert('1.0', text)
        self.summary.configure(state='disabled')
        self.summary.see('1.0')

    def _set_busy(self, busy):
        state = 'disabled' if busy else 'normal'
        self.preview_btn.configure(state=state)
        self.run_btn.configure(state=state)
        self.clear_btn.configure(state=state)
        if not busy:
            self._update_metadata_source_state()

    def _validate_config(self, dry_run):
        target = os.path.abspath(os.path.expanduser(self.target_var.get().strip())) if self.target_var.get().strip() else ''
        source = os.path.abspath(os.path.expanduser(self.source_var.get().strip())) if self.source_var.get().strip() else ''

        if not target or not os.path.isdir(target):
            messagebox.showerror('Target Folder', 'Please choose a valid Target Folder.')
            return None

        metadata_copy = self.metadata_copy_var.get()
        fs_dates = self.fs_dates_var.get()
        source_match = metadata_copy or fs_dates

        if source_match and (not source or not os.path.isdir(source)):
            messagebox.showerror(
                'Metadata Source Folder',
                'Metadata update is enabled. Please choose a valid Metadata Source Folder containing the originals.',
            )
            return None

        exiftool_path = find_exiftool()
        if metadata_copy and not exiftool_path and not dry_run:
            proceed = messagebox.askyesno(
                'ExifTool not found',
                'ExifTool is not available, so embedded metadata/GPS cannot be copied.\n\n'
                'Continue with the other enabled operations anyway?',
            )
            if not proceed:
                return None

        return {
            'dry_run': dry_run,
            'target_folder': target,
            'source_folder': source if source_match else '',
            'enable_rename': self.date_prefix_var.get() or self.be_to_ce_var.get(),
            'enable_date_prefix': self.date_prefix_var.get(),
            'enable_be_to_ce': self.be_to_ce_var.get(),
            'enable_move_live': self.move_live_var.get(),
            'enable_source_match': source_match,
            'enable_metadata_copy': metadata_copy,
            'enable_fs_dates': fs_dates,
            'recursive_source': self.recursive_source_var.get() if source_match else False,
        }

    def _start_job(self, dry_run):
        if self.worker and self.worker.is_alive():
            return

        config = self._validate_config(dry_run)
        if not config:
            return

        if not dry_run:
            enabled_actions = []
            if config['enable_date_prefix']:
                enabled_actions.append('add/refresh YYYYMMDD- prefix')
            if config['enable_be_to_ce']:
                enabled_actions.append('convert B.E. date prefixes to C.E.')
            if config['enable_metadata_copy']:
                enabled_actions.append('copy embedded metadata/GPS')
            if config['enable_fs_dates']:
                enabled_actions.append('change Finder Created/Modified dates')
            if config['enable_move_live']:
                enabled_actions.append('move Live Photo videos')
            enabled_text = ', '.join(enabled_actions) if enabled_actions else 'no write actions'

            confirmed = messagebox.askyesno(
                'Run for Real?',
                'This is NOT a dry run.\n\n'
                f'Target: {config["target_folder"]}\n'
                f'Source: {config["source_folder"] if config["enable_source_match"] else "disabled"}\n\n'
                f'Enabled writes: {enabled_text}\n\n'
                'Continue?',
            )
            if not confirmed:
                return

        self._clear_summary()
        self.progress['value'] = 0
        self.status_var.set('Starting…')
        self._set_busy(True)

        self.worker = threading.Thread(
            target=self._worker_entry,
            args=(config,),
            daemon=True,
        )
        self.worker.start()

    def _worker_entry(self, config):
        def emit(kind, *payload):
            self.events.put((kind, payload))

        try:
            process_job(config, emit)
            emit('done')
        except Exception:
            emit('error', traceback.format_exc())

    def _poll_events(self):
        try:
            while True:
                kind, payload = self.events.get_nowait()

                if kind == 'status':
                    self.status_var.set(payload[0])

                elif kind == 'progress':
                    current, total, label = payload
                    percent = 100 if total <= 0 else max(0, min(100, current / total * 100))
                    self.progress['value'] = percent
                    self.status_var.set(f'{label} — {current}/{total} ({percent:.1f}%)')

                elif kind == 'summary':
                    self._append_summary(payload[0])

                elif kind == 'error':
                    self._set_busy(False)
                    self.status_var.set('Error')
                    self._append_summary(payload[0])
                    messagebox.showerror('Error', 'The job stopped because of an error. See Summary for details.')

                elif kind == 'done':
                    self._set_busy(False)
                    self.progress['value'] = 100
                    self.status_var.set('Done')

        except queue.Empty:
            pass

        self.after(100, self._poll_events)


if __name__ == '__main__':
    app = RenameMetadataApp()
    app.mainloop()

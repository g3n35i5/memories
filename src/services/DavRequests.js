import { getCurrentUser } from '@nextcloud/auth'
import { generateUrl } from '@nextcloud/router'
import { genFileInfo } from './FileUtils'
import client from './DavClient';

const props = `
    <oc:fileid />
    <oc:permissions />
    <d:getlastmodified />
    <d:getetag />
    <d:getcontenttype />
    <d:getcontentlength />
    <nc:has-preview />
    <oc:favorite />
    <d:resourcetype />`;

const IMAGE_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/tiff',
    'image/heic',
];

/**
 * Get file infos for list of files given Ids
 * @param {number[]} fileIds list of file ids
 * @returns {Promise<any[]>} list of file infos
 */
export async function getFiles(fileIds) {
    const prefixPath = `/files/${getCurrentUser().uid}`;

    // IMPORTANT: if this isn't there, then a blank
    // returns EVERYTHING on the server!
    if (fileIds.length === 0) {
        return [];
    }

    const filter = fileIds.map(fileId => `
        <d:eq>
            <d:prop>
                <oc:fileid/>
            </d:prop>
            <d:literal>${fileId}</d:literal>
        </d:eq>
    `).join('');

    const options = {
        method: 'SEARCH',
        headers: {
            'content-Type': 'text/xml',
        },
        data: `<?xml version="1.0" encoding="UTF-8"?>
            <d:searchrequest xmlns:d="DAV:"
                xmlns:oc="http://owncloud.org/ns"
                xmlns:nc="http://nextcloud.org/ns"
                xmlns:ns="https://github.com/icewind1991/SearchDAV/ns"
                xmlns:ocs="http://open-collaboration-services.org/ns">
                <d:basicsearch>
                    <d:select>
                        <d:prop>
                            ${props}
                        </d:prop>
                    </d:select>
                    <d:from>
                        <d:scope>
                            <d:href>${prefixPath}</d:href>
                            <d:depth>0</d:depth>
                        </d:scope>
                    </d:from>
                    <d:where>
                        <d:or>
                            ${filter}
                        </d:or>
                    </d:where>
                </d:basicsearch>
            </d:searchrequest>`,
        deep: true,
        details: true,
        responseType: 'text',
    };

    let response = await client.getDirectoryContents('', options);
    return response.data
        .map(data => genFileInfo(data))
        .map(data => Object.assign({}, data, { filename: data.filename.replace(prefixPath, '') }));
}

/**
 * Get file infos for files in folder path
 * @param {string} folderPath Path to folder
 * @param {number} limit Max number of files to return
 * @returns {Promise<any[]>} list of file infos
 */
export async function getFolderPreviewFileIds(folderPath, limit) {
    const prefixPath = `/files/${getCurrentUser().uid}`;

    const filter = IMAGE_MIME_TYPES.map(mime => `
        <d:like>
            <d:prop>
                <d:getcontenttype/>
            </d:prop>
            <d:literal>${mime}</d:literal>
        </d:like>
    `).join('');

    const options = {
        method: 'SEARCH',
        headers: {
            'content-Type': 'text/xml',
        },
        data: `<?xml version="1.0" encoding="UTF-8"?>
            <d:searchrequest xmlns:d="DAV:"
                xmlns:oc="http://owncloud.org/ns"
                xmlns:nc="http://nextcloud.org/ns"
                xmlns:ns="https://github.com/icewind1991/SearchDAV/ns"
                xmlns:ocs="http://open-collaboration-services.org/ns">
                <d:basicsearch>
                    <d:select>
                        <d:prop>
                            ${props}
                        </d:prop>
                    </d:select>
                    <d:from>
                        <d:scope>
                            <d:href>${prefixPath}/${folderPath}</d:href>
                            <d:depth>0</d:depth>
                        </d:scope>
                    </d:from>
                    <d:where>
                        <d:or>
                            ${filter}
                        </d:or>
                    </d:where>
                    <d:limit>
                        <d:nresults>${limit}</d:nresults>
                    </d:limit>
                </d:basicsearch>
            </d:searchrequest>`,
        deep: true,
        details: true,
        responseType: 'text',
    };

    let response = await client.getDirectoryContents('', options);
    return response.data
        .map(data => genFileInfo(data))
        .map(data => Object.assign({}, data, {
            filename: data.filename.replace(prefixPath, ''),
            etag: data.etag.replace(/&quot;/g, ''), // remove quotes
        }));
}

/**
 * Delete a single file
 *
 * @param {string} path path to the file
 * @returns {Promise<void>}
 */
export async function deleteFile(path) {
    const prefixPath = `/files/${getCurrentUser().uid}`;
    return await client.deleteFile(`${prefixPath}${path}`);
}

/**
 * Delete all files in a given list of Ids
 *
 * @param {number[]} fileIds list of file ids
 * @returns {Promise<Set<number>>} list of file ids that were deleted
 */
export async function deleteFilesByIds(fileIds) {
    const delIds = new Set();
    const fileIdsSet = new Set(fileIds);

    if (fileIds.length === 0) {
        return delIds;
    }

    // Get files data
    let fileInfos = [];
    try {
        fileInfos = await getFiles(fileIds.filter(f => f));
    } catch (e) {
        console.error('Failed to get file info for files to delete', fileIds, e);
        return delIds;
    }

    // Run all promises together
    const promises = [];

    // Delete each file
    for (const fileInfo of fileInfos) {
        if (!fileIdsSet.has(fileInfo.fileid)) {
            continue
        }

        promises.push((async () => {
            try {
                await deleteFile(fileInfo.filename);
                delIds.add(fileInfo.fileid);
            } catch {
                console.error('Failed to delete', fileInfo.filename)
            }
        })());
    }

    await Promise.allSettled(promises);

    return delIds;
}


/**
 * Download a file
 *
 * @param {string[]} fileNames - The file's names
 * @returns {Promise<void>}
 */
 export async function downloadFiles(fileNames) {
    const randomToken = Math.random().toString(36).substring(2)

    const params = new URLSearchParams()
    params.append('files', JSON.stringify(fileNames))
    params.append('downloadStartSecret', randomToken)

    const downloadURL = generateUrl(`/apps/files/ajax/download.php?${params}`)

    window.location = `${downloadURL}downloadStartSecret=${randomToken}`

    return new Promise((resolve) => {
        const waitForCookieInterval = setInterval(
            () => {
                const cookieIsSet = document.cookie
                    .split(';')
                    .map(cookie => cookie.split('='))
                    .findIndex(([cookieName, cookieValue]) => cookieName === 'ocDownloadStarted' && cookieValue === randomToken)

                if (cookieIsSet) {
                    clearInterval(waitForCookieInterval)
                    resolve(true)
                }
            },
            50
        )
    })
}

/**
 * Download the files given by the fileIds
 * @param {number[]} fileIds
 * @returns {Promise<void>}
 */
export async function downloadFilesByIds(fileIds) {
    if (fileIds.length === 0) {
        return;
    }

    // Get files to download
    const fileInfos = await getFiles(fileIds);
    await downloadFiles(fileInfos.map(f => f.filename));
}

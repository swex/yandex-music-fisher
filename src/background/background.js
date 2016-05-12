/* global ga */

require('../vendor/ga');

const utils = require('./utils');
const Yandex = require('./yandex');
const storage = require('./storage');
const downloader = require('./downloader');
const version = chrome.runtime.getManifest().version;
const fisher = {utils, yandex: new Yandex(), storage, downloader};

window.fisher = fisher;

ga('create', 'UA-65530110-1', 'auto');
ga('set', 'checkProtocolTask', null); // разрешает протокол "chrome-extension"
ga('set', 'page', '/home');
ga('send', 'event', 'load', version);

chrome.browserAction.setBadgeBackgroundColor({
    color: [100, 100, 100, 255]
});
fisher.utils.updateBadge();

chrome.runtime.onInstalled.addListener((details) => { // установка или обновление расширения
    storage.init();
    if (details.reason === 'install') {
        ga('send', 'event', 'install', version);
    } else if (details.reason === 'update' && details.previousVersion !== version) {
        ga('send', 'event', 'update', `${details.previousVersion} > ${version}`);
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if ('status' in changeInfo && changeInfo.status === 'loading') { // переход по новому URL
        fisher.utils.updateTabIcon(tab);
    }
});

chrome.tabs.onActivated.addListener((activeInfo) => { // переключение вкладки
    chrome.tabs.get(activeInfo.tabId, (tab) => {
        if ('lastError' in chrome.runtime) {
            console.error(chrome.runtime.lastError.message);
            return;
        }
        fisher.utils.updateTabIcon(tab);
    });
});

chrome.runtime.onMessage.addListener((request) => {
    if (!request || request.action !== 'downloadCurrentTrack' || !request.link) {
        return;
    }
    const page = fisher.utils.getUrlInfo(fisher.yandex.baseUrl + request.link);

    if (!page.isTrack || page.albumId === 'undefined') {
        // временный патч, пока не пофиксят на яндекс.музыке externalAPI.getCurrentTrack().link
        return;
    }

    downloader.downloadTrack(page.trackId, page.albumId);
});

chrome.commands.onCommand.addListener((command) => {
    if (command === 'download_playing_track') {
        chrome.tabs.query({
            url: chrome.runtime.getManifest().content_scripts[0].matches,
            audible: true
        }, (tabs) => {
            tabs.forEach((tab) => {
                chrome.tabs.sendMessage(tab.id, 'downloadCurrentTrack');
            });
        });
    }
});

chrome.downloads.onChanged.addListener((delta) => {
    if (!('state' in delta)) { // состояние не изменилось (начало загрузки)
        fisher.utils.getDownload(delta.id).then(() => chrome.downloads.setShelfEnabled(true));
        // не нашёл способа перехватывать ошибки, когда другое расширение отключает анимацию загрузок
        return;
    }
    fisher.utils.getDownload(delta.id).then((download) => {
        const entity = downloader.getEntityByBrowserDownloadId(delta.id);

        if (entity) {
            // не попадут: архив с обновлением,
            // трек и обложка при удалённой сущности в процессе сохранения BLOB (теоретически, но маловероятно)
            if (delta.state.current === 'complete') {
                entity.status = downloader.STATUS.FINISHED;
                fisher.utils.updateBadge();
            } else if (delta.state.current === 'interrupted') {
                entity.attemptCount++;
                entity.loadedBytes = 0;
                if (entity.attemptCount < 3) {
                    fisher.utils.delay(10000).then(() => {
                        entity.status = downloader.STATUS.WAITING;
                        downloader.download();
                    });
                } else {
                    entity.status = downloader.STATUS.INTERRUPTED;
                    console.error(download.error, entity);
                }
            }
            window.URL.revokeObjectURL(download.url);
        }
        chrome.downloads.erase({
            id: delta.id
        });
        downloader.activeThreadCount--;
        downloader.download();
    });
});

storage.load();

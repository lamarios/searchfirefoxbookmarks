//   Firefox Bookmarks Search Provider for Gnome Shell
//   Copyright (C) 2011  Stefano Ciancio
//
//   This library is free software; you can redistribute it and/or
//   modify it under the terms of the GNU Library General Public
//   License as published by the Free Software Foundation; either
//   version 2 of the License, or (at your option) any later version.
//
//   This library is distributed in the hope that it will be useful,
//   but WITHOUT ANY WARRANTY; without even the implied warranty of
//   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
//   Library General Public License for more details.
//
//   You should have received a copy of the GNU Library General Public
//   License along with this library; if not, write to the Free Software
//   Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA

const Main = imports.ui.main;
const Search = imports.ui.search;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Shell = imports.gi.Shell;
const Util = imports.misc.util;
const St = imports.gi.St;

// Settings

// FBSearchProvider holds the instance of the search provider
// implementation. If null, the extension is either uninitialized
// or has been disabled via disable().
var FBSearchProvider = null;

var bookmarkFileMonitor = null;

let ShellVersion = imports.misc.config.PACKAGE_VERSION.split('.');

function FirefoxBookmarksSearchProvider() {
    this._init.apply(this, arguments);
}
FirefoxBookmarksSearchProvider.prototype = {
    __proto__: Search.SearchProvider.prototype,

    _init: function () {
        Search.SearchProvider.prototype._init.call(this, "FIREFOX BOOKMARKS");

        // Retrieve environment variables
        this.FirefoxBookmarkBackupsDir = GLib.getenv("FIREFOX_BOOKMARK_BACKUPS_DIR");
        this.FirefoxBookmarkFile = GLib.getenv("FIREFOX_BOOKMARK_FILE");

        // Check environment variables
        if (this.FirefoxBookmarkFile != null) {
            // Env Bookmark File defined
            this.bookmarkFilePath = this.FirefoxBookmarkFile;

        } else if (this.FirefoxBookmarkBackupsDir != null) {
            // Env Bookmark Dir defined
            if ( !(this.bookmarkFilePath = this._getBookmarkFilePath(this.FirefoxBookmarkBackupsDir)) ) {
                return false;
            }
        } else {
            // Default
            let firefoxProfileFile = GLib.build_filenamev([GLib.get_home_dir(), ".mozilla/firefox/profiles.ini"]);
            var [result, defaultProfile, defaultIsRelative] = this._getFirefoxDefaultProfile(firefoxProfileFile);

            let mozillaDefaultDirPath = "";
            if (defaultIsRelative == 1) {
                mozillaDefaultDirPath = GLib.build_filenamev([GLib.get_home_dir(), ".mozilla/firefox/", 
                            defaultProfile, "bookmarkbackups/"]);
            } else {
                mozillaDefaultDirPath = GLib.build_filenamev([defaultProfile, "bookmarkbackups/"]);
            }

            if ( !(this.bookmarkFilePath = this._getBookmarkFilePath(mozillaDefaultDirPath)) ) {
                return false;
            }
        }

        this._configBookmarks = [];

        this._readBookmarks();

        let file = Gio.file_new_for_path(this.bookmarkFilePath);
        bookmarkFileMonitor = file.monitor(Gio.FileMonitorFlags.NONE, null);
        bookmarkFileMonitor.connect('changed', Lang.bind(this, this._readBookmarks));

        return true;
    },


    _getFirefoxDefaultProfile : function (firefoxProfileFile) {

        let last_path, last_default, last_isrelative, default_path, default_isrelative;

        if (GLib.file_test(firefoxProfileFile, GLib.FileTest.EXISTS) ) {
            let filedata = GLib.file_get_contents(firefoxProfileFile, null, 0);

            if (filedata[0]) {
                let lines = String(filedata[1]).split('\n');

                for (let i=0; i<lines.length; i++) {
                    if (lines[i] == '') continue;           // empty lines

                    var key_value = lines[i].match(/([^]*)=([^]*)/);
                    if (key_value != null) {                // key-value pair
                        if (key_value[1] == 'Path') last_path = key_value[2];
                        if (key_value[1] == 'IsRelative') last_isrelative = key_value[2];
                        if (key_value[1] == 'Default') last_default = key_value[2];

                        default_path = last_path;
                        default_isrelative = last_isrelative;
                        if (last_default == 1) break; else continue;
                    }
                }
            }

        } else return [false, "File not exist"];

        return [true, default_path, default_isrelative];
    },

    // Read all bookmarks tree
    _readBookmarks : function () {

        let filedata;
        try {
            filedata = GLib.file_get_contents(this.bookmarkFilePath, null, 0);
        } catch (e) {
            Main.notifyError("Error reading file", e.message);
            return false;
        }

        let jsondata = null;
        if ( (filedata[1].length != 0) && (filedata[1] != null) ) {
            try {
                jsondata = JSON.parse (filedata[1]);
            } catch (e) {
                Main.notifyError("Error parsing file - "+ filedata, e.message);
                return false;
            }
        } else {
            Main.notifyError("Error parsing file - Empty data");
            return false;
        }

        // Check to find right tree
        let toolbarMenu = '';
        for (let i = 0; i < jsondata.children.length; i++) {
            let child = jsondata.children[i];

            if (child.root == 'tagsFolder') continue;

            this._readTree(child.children, this);
        }

        return true;
    },

    _readTree : function (node, parent) {

        let child, menuItem, menuSep, menuSub, ident_prec;

        // For each child ... 
        for (let i = 0; i < node.length; i++) {
            child = node[i];

            if (child.hasOwnProperty('type')) {
                if (child.type == 'text/x-moz-place') {
                    this._configBookmarks.push([child.title, child.uri]);
                }

                if (child.type == 'text/x-moz-place-container') {
                    this._readTree(child.children, menuSub);
                }
            }
        }
    },

    // Return complete path of bookmark json file
    // bookmarkDir: dir of json bookmark file
    _getBookmarkFilePath : function (bookmarkDir) {

        let dir = '';
        if ((bookmarkDir) && GLib.file_test(bookmarkDir, GLib.FileTest.IS_DIR) ) {
            dir = Gio.file_new_for_path(bookmarkDir);
            var backupEnum = dir.enumerate_children('standard::name,standard::type,time::modified',
                                                    Gio.FileQueryInfoFlags.NONE, null);
        } else {
            Main.notifyError("Directory Error", bookmarkDir + " seems doesn't exist");
            return false;
        }

        let infoTimeVal = new GLib.TimeVal();
        let max = 0;
        let info;
        while ((info = backupEnum.next_file(null)) != null) {

            let type = info.get_file_type();

            if (type == Gio.FileType.REGULAR) {

                let infoTimeVal;
                if (ShellVersion[1] < 4) {
                    infoTimeVal = new GLib.TimeVal();
                    info.get_modification_time(infoTimeVal);
                } else {
                    infoTimeVal = info.get_modification_time();
                }

                if (infoTimeVal.tv_sec > max) {
                    max = infoTimeVal.tv_sec;
                    var lastFile = info;

                }
            }
        }
        backupEnum.close(null);

        if ( (typeof(lastFile) == 'undefined') || 
                !GLib.file_test(GLib.build_filenamev([bookmarkDir, lastFile.get_name()]), GLib.FileTest.EXISTS) ) {
            Main.notifyError("Directory Error", "It seems are no files in " + bookmarkDir);
            return false;
        }

        return GLib.build_filenamev([bookmarkDir, lastFile.get_name()]);
    },

    getResultMeta: function (id) {
        let bookmark_name = "";
        if (id.name.trim())
            bookmark_name = id.name;
        else
            bookmark_name = id.url;

        return {
            id: id,
            name: bookmark_name,
            createIcon: function (size) {
                let icon = new St.Icon({
                    gicon: new Gio.ThemedIcon({name: 'firefox'}),
                    icon_size: size
                });
                icon.icon_type = St.IconType.FULLCOLOR;
                return icon;
            }
        };
    },

    getResultMetas: function (resultIds) {
        return resultIds.map(this.getResultMeta);
    },

    activateResult: function(id) {
        Util.spawn(['/usr/bin/firefox', '--new-tab', id.url]);
    },

    _checkBookmarknames: function(bookmarks, terms) {
        let searchResults = [];
        for (var i=0; i<bookmarks.length; i++) {
            for (var j=0; j<terms.length; j++) {
                try {
                    let name = bookmarks[i][0];
                    let url = bookmarks[i][1];
                    let searchStr = name+url;
                    let pattern = new RegExp(terms[j],"gi");
                    if (searchStr.match(pattern)) {

                        searchResults.push({
                                'name': name,
                                'url': url
                        });
                    }
                }
                catch(ex) {
                    continue;
                }
            }
        }
        return searchResults;
    },

    getInitialResultSet: function(terms) {
        log('getInitialResultSet');
        // check if a found host-name begins like the search-term
        let searchResults = [];
        searchResults = searchResults.concat(this._checkBookmarknames(this._configBookmarks, terms));

        if (searchResults.length > 0) {
            return(searchResults);
        }

        return []
    },

    getSubsearchResultSet: function(previousResults, terms) {
        return this.getInitialResultSet(terms);
    }
};

function init(meta) {
}

function enable() {
    if (FBSearchProvider==null) {
        FBSearchProvider = new FirefoxBookmarksSearchProvider();
        Main.overview.addSearchProvider(FBSearchProvider);
    }
}

function disable() {
    if (FBSearchProvider!=null) {
        Main.overview.removeSearchProvider(FBSearchProvider);
        FBSearchProvider = null;
    }

    bookmarkFileMonitor.cancel();
}


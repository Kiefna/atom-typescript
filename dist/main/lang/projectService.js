var fs = require('fs');
var path = require('path');
var ts = require('typescript');
var fuzzaldrin = require('fuzzaldrin');
var tsconfig = require('../tsconfig/tsconfig');
var utils = require('./utils');
var project = require('./project');
var Project = project.Project;
var languageServiceHost = project.languageServiceHost;
var resolve = Promise.resolve.bind(Promise);
var queryParent = require('../../worker/queryParent');
var child;
function fixChild(childInjected) {
    child = childInjected;
    queryParent.echoNumWithModification = child.sendToIpc(queryParent.echoNumWithModification);
    queryParent.getUpdatedTextForUnsavedEditors = child.sendToIpc(queryParent.getUpdatedTextForUnsavedEditors);
    queryParent.getOpenEditorPaths = child.sendToIpc(queryParent.getOpenEditorPaths);
    queryParent.setConfigurationError = child.sendToIpc(queryParent.setConfigurationError);
    queryParent.notifySuccess = child.sendToIpc(queryParent.notifySuccess);
}
exports.fixChild = fixChild;
var projectByProjectFilePath = {};
var projectByFilePath = {};
var watchingProjectFile = {};
function watchProjectFileIfNotDoingItAlready(projectFilePath) {
    if (!fs.existsSync(projectFilePath)) {
        return;
    }
    if (watchingProjectFile[projectFilePath])
        return;
    watchingProjectFile[projectFilePath] = true;
    fs.watch(projectFilePath, {
        persistent: false,
        recursive: false
    }, function () {
        if (!fs.existsSync(projectFilePath)) {
            var project = projectByProjectFilePath[projectFilePath];
            if (project) {
                var files = project.projectFile.project.files;
                delete projectByProjectFilePath[projectFilePath];
                files.forEach(function (file) {
                    return delete projectByFilePath[file];
                });
            }
            return;
        }
        try {
            var projectFile = getOrCreateProjectFile(projectFilePath);
            cacheAndCreateProject(projectFile);
            queryParent.setConfigurationError({
                projectFilePath: projectFile.projectFilePath,
                error: null
            });
        }
        catch (ex) {
        }
    });
}
var chokidar = require('chokidar');
var watchingTheFilesInTheProject = {};
function watchTheFilesInTheProjectIfNotDoingItAlready(projectFile) {
    var projectFilePath = projectFile.projectFilePath;
    if (!fs.existsSync(projectFilePath)) {
        return;
    }
    if (watchingTheFilesInTheProject[projectFilePath])
        return;
    watchingTheFilesInTheProject[projectFilePath] = true;
    var watcher = chokidar.watch(projectFile.project.files || projectFile.project.filesGlob);
    watcher.on('add', function () {
    });
    watcher.on('unlink', function (filePath) {
    });
    watcher.on('change', function (filePath) {
        filePath = tsconfig.consistentPath(filePath);
        queryParent.getOpenEditorPaths({}).then(function (res) {
            var openPaths = res.filePaths;
            if (openPaths.some(function (x) {
                return x == filePath;
            })) {
                return;
            }
            var project = projectByFilePath[filePath];
            if (!project) {
                return;
            }
            var contents = fs.readFileSync(filePath).toString();
            project.languageServiceHost.updateScript(filePath, contents);
        });
    });
}
function cacheAndCreateProject(projectFile) {
    var project = projectByProjectFilePath[projectFile.projectFilePath] = new Project(projectFile);
    projectFile.project.files.forEach(function (file) {
        return projectByFilePath[file] = project;
    });
    queryParent.getUpdatedTextForUnsavedEditors({}).then(function (resp) {
        resp.editors.forEach(function (e) {
            consistentPath(e);
            project.languageServiceHost.updateScript(e.filePath, e.text);
        });
    });
    watchProjectFileIfNotDoingItAlready(projectFile.projectFilePath);
    watchTheFilesInTheProjectIfNotDoingItAlready(projectFile);
    return project;
}
function getOrCreateProjectFile(filePath) {
    try {
        if (path.dirname(filePath) == path.dirname(languageServiceHost.defaultLibFile)) {
            return tsconfig.getDefaultProject(filePath);
        }
        var projectFile = tsconfig.getProjectSync(filePath);
        queryParent.setConfigurationError({
            projectFilePath: projectFile.projectFilePath,
            error: null
        });
        return projectFile;
    }
    catch (ex) {
        var err = ex;
        if (err.message === tsconfig.errors.GET_PROJECT_NO_PROJECT_FOUND) {
            if (tsconfig.endsWith(filePath.toLowerCase(), '.d.ts')) {
                return tsconfig.getDefaultProject(filePath);
            }
            else {
                var projectFile = tsconfig.createProjectRootSync(filePath);
                queryParent.notifySuccess({
                    message: 'AtomTS: tsconfig.json file created: <br/>' + projectFile.projectFilePath
                });
                queryParent.setConfigurationError({
                    projectFilePath: projectFile.projectFilePath,
                    error: null
                });
                return projectFile;
            }
        }
        else {
            if (ex.message === tsconfig.errors.GET_PROJECT_JSON_PARSE_FAILED) {
                var details = ex.details;
                queryParent.setConfigurationError({
                    projectFilePath: details.projectFilePath,
                    error: {
                        message: ex.message,
                        details: ex.details
                    }
                });
                watchProjectFileIfNotDoingItAlready(details.projectFilePath);
            }
            if (ex.message === tsconfig.errors.GET_PROJECT_PROJECT_FILE_INVALID_OPTIONS) {
                var _details = ex.details;
                queryParent.setConfigurationError({
                    projectFilePath: _details.projectFilePath,
                    error: {
                        message: ex.message,
                        _details: ex.details
                    }
                });
                watchProjectFileIfNotDoingItAlready(_details.projectFilePath);
            }
            throw ex;
        }
    }
}
function getOrCreateProject(filePath) {
    filePath = tsconfig.consistentPath(filePath);
    if (projectByFilePath[filePath]) {
        return projectByFilePath[filePath];
    }
    else {
        var projectFile = getOrCreateProjectFile(filePath);
        var project = cacheAndCreateProject(projectFile);
        return project;
    }
}
function textSpan(span) {
    return {
        start: span.start,
        length: span.length
    };
}
function consistentPath(query) {
    if (!query.filePath)
        return;
    query.filePath = tsconfig.consistentPath(query.filePath);
}
function echo(data) {
    return queryParent.echoNumWithModification({
        num: data.num
    }).then(function (resp) {
        data.num = resp.num;
        return data;
    });
}
exports.echo = echo;
function quickInfo(query) {
    consistentPath(query);
    var project = getOrCreateProject(query.filePath);
    var info = project.languageService.getQuickInfoAtPosition(query.filePath, query.position);
    if (!info)
        return Promise.resolve({
            valid: false
        });
    else
        return resolve({
            valid: true,
            name: ts.displayPartsToString(info.displayParts || []),
            comment: ts.displayPartsToString(info.documentation || []),
        });
}
exports.quickInfo = quickInfo;
function build(query) {
    consistentPath(query);
    return resolve({
        outputs: getOrCreateProject(query.filePath).build()
    });
}
exports.build = build;
function errorsForFileFiltered(query) {
    consistentPath(query);
    var fileName = path.basename(query.filePath);
    return errorsForFile({
        filePath: query.filePath
    }).then(function (resp) {
        return {
            errors: resp.errors.filter(function (error) {
                return path.basename(error.filePath) == fileName;
            })
        };
    });
}
exports.errorsForFileFiltered = errorsForFileFiltered;
var punctuations = utils.createMap([
    ';',
    '{',
    '}',
    '(',
    ')',
    '.',
    ':',
    '<',
    '>',
    "'",
    '"'
]);
var prefixEndsInPunctuation = function (prefix) {
    return prefix.length && prefix.trim().length && punctuations[prefix.trim()[prefix.trim().length - 1]];
};
function getCompletionsAtPosition(query) {
    consistentPath(query);
    var filePath = query.filePath, position = query.position, prefix = query.prefix;
    var project = getOrCreateProject(filePath);
    var completions = project.languageService.getCompletionsAtPosition(filePath, position);
    var completionList = completions ? completions.entries.filter(function (x) {
        return !!x;
    }) : [];
    var endsInPunctuation = prefixEndsInPunctuation(prefix);
    if (prefix.length && !endsInPunctuation) {
        completionList = fuzzaldrin.filter(completionList, prefix, {
            key: 'name'
        });
    }
    if (completionList.length > query.maxSuggestions)
        completionList = completionList.slice(0, query.maxSuggestions);
    function docComment(c) {
        var completionDetails = project.languageService.getCompletionEntryDetails(filePath, position, c.name);
        var display;
        if (c.kind == "method" || c.kind == "function") {
            display = ts.displayPartsToString(completionDetails.displayParts || []);
        }
        else if (c.kind == "property") {
            display = ts.displayPartsToString(completionDetails.displayParts || []);
        }
        else {
            display = c.kind;
        }
        var comment = ts.displayPartsToString(completionDetails.documentation || []);
        return {
            display: display,
            comment: comment
        };
    }
    return resolve({
        completions: completionList.map(function (c) {
            var details = docComment(c);
            return {
                name: c.name,
                kind: c.kind,
                comment: details.comment,
                display: details.display
            };
        }),
        endsInPunctuation: endsInPunctuation
    });
}
exports.getCompletionsAtPosition = getCompletionsAtPosition;
function getSignatureHelps(query) {
    consistentPath(query);
    var project = getOrCreateProject(query.filePath);
    var signatureHelpItems = project.languageService.getSignatureHelpItems(query.filePath, query.position);
    if (!signatureHelpItems || !signatureHelpItems.items || !signatureHelpItems.items.length)
        return resolve({
            signatureHelps: []
        });
    return signatureHelpItems.items;
}
exports.getSignatureHelps = getSignatureHelps;
function emitFile(query) {
    consistentPath(query);
    return resolve(getOrCreateProject(query.filePath).emitFile(query.filePath));
}
exports.emitFile = emitFile;
function formatDocument(query) {
    consistentPath(query);
    var prog = getOrCreateProject(query.filePath);
    return resolve(prog.formatDocument(query.filePath, query.cursor));
}
exports.formatDocument = formatDocument;
function formatDocumentRange(query) {
    consistentPath(query);
    var prog = getOrCreateProject(query.filePath);
    return resolve({
        formatted: prog.formatDocumentRange(query.filePath, query.start, query.end)
    });
}
exports.formatDocumentRange = formatDocumentRange;
function getDefinitionsAtPosition(query) {
    consistentPath(query);
    var project = getOrCreateProject(query.filePath);
    var definitions = project.languageService.getDefinitionAtPosition(query.filePath, query.position);
    var projectFileDirectory = project.projectFile.projectFileDirectory;
    if (!definitions || !definitions.length)
        return resolve({
            projectFileDirectory: projectFileDirectory,
            definitions: []
        });
    return resolve({
        projectFileDirectory: projectFileDirectory,
        definitions: definitions.map(function (d) {
            var pos = project.languageServiceHost.getPositionFromIndex(d.fileName, d.textSpan.start);
            return {
                filePath: d.fileName,
                position: pos
            };
        })
    });
}
exports.getDefinitionsAtPosition = getDefinitionsAtPosition;
function updateText(query) {
    consistentPath(query);
    getOrCreateProject(query.filePath).languageServiceHost.updateScript(query.filePath, query.text);
    return resolve({});
}
exports.updateText = updateText;
function editText(query) {
    consistentPath(query);
    getOrCreateProject(query.filePath).languageServiceHost.editScript(query.filePath, query.minChar, query.limChar, query.newText);
    return resolve({});
}
exports.editText = editText;
function errorsForFile(query) {
    consistentPath(query);
    var program = getOrCreateProject(query.filePath);
    var diagnostics = program.languageService.getSyntacticDiagnostics(query.filePath);
    if (diagnostics.length === 0) {
        diagnostics = program.languageService.getSemanticDiagnostics(query.filePath);
    }
    return resolve({
        errors: diagnostics.map(project.diagnosticToTSError)
    });
}
exports.errorsForFile = errorsForFile;
function getRenameInfo(query) {
    consistentPath(query);
    var project = getOrCreateProject(query.filePath);
    var findInStrings = false, findInComments = false;
    var info = project.languageService.getRenameInfo(query.filePath, query.position);
    if (info && info.canRename) {
        var locations = {};
        project.languageService.findRenameLocations(query.filePath, query.position, findInStrings, findInComments).forEach(function (loc) {
            if (!locations[loc.fileName])
                locations[loc.fileName] = [];
            locations[loc.fileName].unshift(textSpan(loc.textSpan));
        });
        return resolve({
            canRename: true,
            localizedErrorMessage: info.localizedErrorMessage,
            displayName: info.displayName,
            fullDisplayName: info.fullDisplayName,
            kind: info.kind,
            kindModifiers: info.kindModifiers,
            triggerSpan: textSpan(info.triggerSpan),
            locations: locations
        });
    }
    else {
        return resolve({
            canRename: false
        });
    }
}
exports.getRenameInfo = getRenameInfo;
function filePathWithoutExtension(query) {
    var base = path.basename(query, '.ts');
    return path.dirname(query) + '/' + base;
}
function getRelativePathsInProject(query) {
    consistentPath(query);
    var project = getOrCreateProject(query.filePath);
    var sourceDir = path.dirname(query.filePath);
    var filePaths = project.projectFile.project.files.filter(function (p) {
        return p !== query.filePath;
    });
    var files = filePaths.map(function (p) {
        return {
            name: path.basename(p, '.ts'),
            relativePath: tsconfig.removeExt(tsconfig.makeRelativePath(sourceDir, p)),
            fullPath: p
        };
    });
    var endsInPunctuation = prefixEndsInPunctuation(query.prefix);
    if (!endsInPunctuation)
        files = fuzzaldrin.filter(files, query.prefix, {
            key: 'name'
        });
    var response = {
        files: files,
        endsInPunctuation: endsInPunctuation
    };
    return resolve(response);
}
exports.getRelativePathsInProject = getRelativePathsInProject;
function getIndentationAtPosition(query) {
    consistentPath(query);
    var project = getOrCreateProject(query.filePath);
    var indent = project.languageService.getIndentationAtPosition(query.filePath, query.position, project.projectFile.project.formatCodeOptions);
    return resolve({
        indent: indent
    });
}
exports.getIndentationAtPosition = getIndentationAtPosition;
function debugLanguageServiceHostVersion(query) {
    consistentPath(query);
    var project = getOrCreateProject(query.filePath);
    return resolve({
        text: project.languageServiceHost.getScriptContent(query.filePath)
    });
}
exports.debugLanguageServiceHostVersion = debugLanguageServiceHostVersion;
function getProjectFileDetails(query) {
    consistentPath(query);
    var project = getOrCreateProject(query.filePath);
    return resolve(project.projectFile);
}
exports.getProjectFileDetails = getProjectFileDetails;
//# sourceMappingURL=projectService.js.map
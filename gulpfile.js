'use strict';

var path = require('path'),
    fs = require('fs'),
    fsExtra = require('fs-extra'),
    cp = require('child_process'),

    Q = require('q'),
    enb = require('enb'),
    rimraf = require('rimraf'),
    mkdirp = require('mkdirp'),

    gulp = require('gulp'),
    batch = require('gulp-batch'),
    watch = require('gulp-watch'),
    browserSync = require('browser-sync'),
    csscomb = require('gulp-csscomb'),

    prepareLibs = require('./lib/prepare-libs'),
    prepareModel = require('./lib/prepare-model'),

    fsHelpers = require('./libs/bem-lib-site-view/lib/fs-helpers');

let model;

const env = process.env;

const LANGUAGES = env.LANGUAGES ? env.LANGUAGES.split(',') : ['en', 'ru', 'uk'];

const CACHE = './.cache';

const CACHE_DIRS = LANGUAGES.reduce((prev, language) => {
    prev[language] = CACHE + '/gorshochek-cache-' + language;
    return prev;
}, {});
const DATA_DIR_PREFIX = CACHE + '/gorshochek-data-';
const DATA_DIRS = LANGUAGES.reduce((prev, language) => {
    prev[language] = DATA_DIR_PREFIX + language;
    return prev;
}, {});
const STATIC = './static';
const OUTPUT = './output';
const OUTPUT_ROOT = OUTPUT + '/bem.info/';
const OUTPUT_DIRS = LANGUAGES.reduce((prev, language) => {
    prev[language] = OUTPUT_ROOT + language;
    return prev;
}, {});

const BUNDLES_DIR = 'bundles';
const BUNDLES = fs.readdirSync(BUNDLES_DIR);
const BEMTREE = BUNDLES.reduce((prev, bundle) => {
    LANGUAGES.forEach(lang => {
        prev[lang] || (prev[lang] = {});
        prev[lang][bundle] = path.join(BUNDLES_DIR, bundle, bundle + '.' + lang + '.bemtree.js');
    });

    return prev;
}, {});
const BEMHTML = BUNDLES.reduce((prev, bundle) => {
    LANGUAGES.forEach(lang => {
        prev[lang] || (prev[lang] = {});
        prev[lang][bundle] = path.join(BUNDLES_DIR, bundle, bundle + '.' + lang + '.bemhtml.js');
    });

    return prev;
}, {});

function runSubProcess(file, options) {
    const defer = Q.defer();
    const proc = cp.fork(file, options);
    proc.on('error', (error) => defer.reject(error));
    proc.on('close', () => defer.resolve());
    proc.on('exit', () => defer.resolve());
    return defer.promise;
}

function compilePages(lang, bundle) {
    return runSubProcess('./lib/template.js', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: {
            GORSHOCHEK_CACHE_FOLDER: CACHE_DIRS[lang],
            bemtree: BEMTREE[lang][bundle],
            bemhtml: BEMHTML[lang][bundle],
            bundle,
            static: STATIC,
            source: DATA_DIRS[lang],
            destination: OUTPUT_DIRS[lang],
            destinationRoot: OUTPUT + (env.YENV === 'production' ? '/bem.info/static' : ''),
            langs: LANGUAGES,
            sites: env.SITES ? env.SITES.split(',') : ['methodology', 'toolbox', 'platform', 'community'],
            lang,
            DEBUG: env.DEBUG,
            YENV: env.YENV
        }
    });
}

// Подготовка директорий output-*

gulp.task('prepare-output', () => {
    return new Promise((resolve) => {
        fsExtra.remove(OUTPUT, () => {
            fsExtra.copy(path.join(CACHE, OUTPUT), OUTPUT, () => resolve());
        });
    });
});

gulp.task('prepare-static', () => {
    return Q.all(
        gulp.src(path.join(STATIC, '{index.html,robots.txt,.nojekyll}'))
            .pipe(gulp.dest(OUTPUT))
            .pipe(gulp.dest(OUTPUT_ROOT)),

        LANGUAGES.map(lang => gulp.src(path.join(STATIC, '{favicon.ico,robots.txt}'))
            .pipe(gulp.dest(OUTPUT_DIRS[lang])))
    );
});

// Сборка данных

function data() {
    mkdirp.sync(CACHE);

    return Q.all(LANGUAGES.map(lang => {
        const preparedModel = prepareModel(model, lang);

        const modelPath = path.join(CACHE, `model.${lang}.json`);
        fs.writeFileSync(modelPath, JSON.stringify(preparedModel.model));

        if (preparedModel.redirects && preparedModel.redirects.length) {
            const redirectsPath = path.join(CACHE, OUTPUT_ROOT, lang, `redirects.json`);
            fs.writeFileSync(redirectsPath, JSON.stringify(preparedModel.redirects, null, 2));
        }

        return runSubProcess('./lib/data-builder.js', {
            cwd: process.cwd(),
            encoding: 'utf-8',
            env: {
                GORSHOCHEK_CACHE_FOLDER: CACHE_DIRS[lang],
                modelPath: modelPath,
                host: `https://${lang}.bem.info`,
                dest: DATA_DIRS[lang],
                root: env.YENV === 'production' ? '' : '/bem.info/' + lang,
                token: env.TOKEN,
                DEBUG: env.DEBUG,
                githubHosts: env.GITHUB_HOSTS
            }
        });
    })).then(() => fsHelpers.touch(path.join(CACHE, '.inited')));
}

gulp.task('prepare-model', () => {
    rimraf.sync(path.join(CACHE, OUTPUT));

    return Q.all(prepareLibs(require(env.PATH_TO_MODEL || './content/model.js')))
        .then(pages => {
            model = pages;
        });
});

gulp.task('prepare-data', data);

gulp.task('data', gulp.series('prepare-model', 'prepare-data'));

gulp.task('is-data-exists', () => {
    return fsHelpers.exists(path.join(CACHE, '.inited')).then(doesExists => {
        if (doesExists) {
            return Promise.resolve();
        }

        throw Error('Data is not initialized in ' + CACHE + ', run `gulp data`');
    });
});

// Шаблонизация данных

gulp.task('enb-make', enb.make);

function copyStatic() {
    return Q.all(LANGUAGES.map(lang => {
        const files = BUNDLES.map(bundle =>
            path.join(BUNDLES_DIR, bundle, bundle + '*.min.*'));

        files.push(path.join(OUTPUT_ROOT, 'static', '*'));

        return gulp.src(files).pipe(gulp.dest(OUTPUT_DIRS[lang]));
    }));
}

gulp.task('copy-static', copyStatic);

gulp.task('copy-sitemap-xml', () => Q.all(LANGUAGES.map(lang => {
    return gulp.src(path.join(DATA_DIRS[lang], 'sitemap.xml'))
        .pipe(gulp.dest(path.join(OUTPUT_DIRS[lang])));
})));

gulp.task('build-html', () => Q.all(LANGUAGES.map(lang => {
    return Q.all(BUNDLES.map(compilePages.bind(null, lang)));
})));

gulp.task('copy-static-images', () => Q.all(LANGUAGES.map(lang => {
    // FIXME: use '/static/*' then https://github.com/bem-site/gorshochek/issues/49 would be resolved
    return gulp.src(path.join(DATA_DIRS[lang], '/*.{gif,png,jpg,svg,svgz,svgd}'))
        .pipe(gulp.dest(OUTPUT_DIRS[lang]));
})));

gulp.task('compile-pages', gulp.series(
    'enb-make',
    'copy-static',
    'copy-static-images',
    'copy-sitemap-xml',
    'build-html'
));

// Наблюдатель

gulp.task('watch', () => {
    watch(['content/**/*'], batch((event, done) => {
        data().then(done);
    }));

    watch(['blocks/**/*'], batch((event, done) => {
        enb.make().then(() => copyStatic().then(done));
    }));

    // compile pages then bemtree/bemhtml bundle or data changes
    BUNDLES.forEach(bundle => {
        var cwd = process.cwd(),
            bemtree = LANGUAGES.map(lang => path.join(cwd, BEMTREE[lang][bundle])),
            bemhtml = LANGUAGES.map(lang => path.join(cwd, BEMHTML[lang][bundle]));

        watch(bemtree.concat(bemhtml, [
                path.join(DATA_DIR_PREFIX + '*', bundle, '**'),
                path.join(DATA_DIR_PREFIX + '*', bundle + '.js')
            ]),
            batch((event, done) => {
                bemhtml.forEach(pathToBemhtml => delete require.cache[pathToBemhtml]);
                bemtree.forEach(pathToBemtree => delete require.cache[pathToBemtree]);
                Q.all(LANGUAGES.map(lang => compilePages(lang, bundle))).then(done);
            }
        ));
    });
});

gulp.task('browser-sync', () => {
    browserSync.create().init({
        files: OUTPUT + '/**',
        server: { baseDir: OUTPUT },
        port: 8008,
        open: false,
        online: false,
        logLevel: 'silent',
        notify: false,
        ui: false,
        middleware: function(req, res, next) {
            if (req.url.match(/svgd/)) {
                res.setHeader('Content-Type', 'image/svg+xml');
                res.setHeader('Content-Encoding', 'deflate')
            }
            next();
        }
    });
});

gulp.task('libs-build', function() {
    // require('bem-lib-site-generator').data(path.resolve('path/to/library'));
});

gulp.task('csscomb', function() {
    return gulp.src('blocks/**/*.css', { base: './' })
        .pipe(csscomb())
        .pipe(gulp.dest('./'));
});

gulp.task('default', gulp.series(
    'is-data-exists',
    gulp.parallel('prepare-output', 'copy-static-images', 'enb-make'),
    gulp.parallel('build-html', 'copy-static', 'copy-sitemap-xml'),
//    'csscomb',
    gulp.parallel('watch', 'browser-sync')
));

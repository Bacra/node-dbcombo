var etag		= require('etag');
var mime		= require('mime');
var Checker		= require('./lib/check_paths').Checker;
var combo		= require('./lib/combo');
var urlCombo	= require('./lib/url_combo_parser');
var DBFile		= require('./lib/dbfile').DBFile;
var debug		= require('debug')('combo:express');


module.exports = handle;

function handle(options)
{
	options || (options = {});
	if (!options.root) options.root = process.cwd()+'/';

	var multiParser	= options.multiParser || new urlCombo.MultiFiles(options);
	var dbParser	= options.dbParser || new urlCombo.DBFiles(options);
	var checker		= options.checker || new Checker(options);
	var dbFile		= options.dbFile || new DBFile(options);

	options.maxage = Math.floor(Math.max(0, Number(options.maxage) || 3600*365));


	function paseMulti(url)
	{
		return new Promise(function(resolve)
			{
				resolve(multiParser.parse(url));
			})
			.catch(function(err)
			{
				debug('MultiFiles parse err:%o', err);
			});
	}

	function paseDB(url)
	{
		return new Promise(function(resolve)
			{
				resolve(dbParser.parse(url));
			})
			.then(function(fileinfo)
			{
				debug('db fileinfo: %o', fileinfo);
				return dbFile.handle(options.root, fileinfo.db, fileinfo.list);
			})
			.catch(function(err)
			{
				debug('db parse err:%o, %s', err, err.stack);
			});
	}


	return function(req, res, next)
	{
		if (req.method && req.method != 'GET') return next();

		var url = req.url;
		debug('start url:%s', url);
		var startTime = Date.now();

		return Promise.all(
			[
				options.enabledDBParser && paseDB(url),
				options.enabledMultiParser && paseMulti(url)
			])
			.then(function(data)
			{
				var files = data[0] || data[1];
				if (!files) return next();

				return new Promise(function(resolve)
					{
						debug('check files:%o', files);
						checker.check(files);
						resolve();
					})
					.then(function()
					{
						return new Promise(function(resolve, reject)
							{
								var comboStartTime = Date.now();
								var ws = combo.createComboStream(files, options);

								debug('combo start:%s', url);
								ws.pipe(res);
								ws.once('error', reject)
									.once('check', function(stats)
									{
										setResHeader(req, res, stats, options);
										debug('combo check:%dms', Date.now() - comboStartTime);
									})
									.once('end', function()
									{
										debug('combo send:%dms', Date.now() - comboStartTime);
										resolve();
									});
							});
					})
					.then(function()
					{
						debug('combo end:%dms', Date.now() - startTime);
					});
			})
			.catch(function(err)
			{
				debug('combo err:%o', err);
				next(err)
			});
	}
}




function setResHeader(req, res, stats, options)
{
	if (res._header)
	{
		debug('headers already sent');
	}
	else
	{
		if (!res.getHeader('Content-Length'))
		{
			var contentLength = 0;
			stats.stats.forEach(function(stat)
			{
				contentLength += stat.size;
			});

			debug('content len:%d', contentLength);
			res.setHeader('Content-Length', contentLength);
		}

		if (!res.getHeader('Content-Type'))
		{
			var type = mime.lookup(req.url);
			var charset = mime.charsets.lookup(type);
			debug('content-type %s', type);
			res.setHeader('Content-Type', type + (charset ? '; charset=' + charset : ''));
		}

		if (!res.getHeader('Cache-Control'))
		{
			res.setHeader('Cache-Control', 'public, max-age=' + options.maxage);
		}


		var lastStat = stats.lastMtime();
		debug('lastStat mtime:%s', lastStat.mime);

		if (!res.getHeader('Last-Modified'))
		{
			res.setHeader('Last-Modified', lastStat.mtime.toUTCString());
		}

		if (!res.getHeader('ETag'))
		{
			res.setHeader('ETag', etag(lastStat));
		}
	}
}



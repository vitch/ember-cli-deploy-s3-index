/* jshint node: true */
'use strict';

var AWS             = require('aws-sdk');
var CoreObject      = require('core-object');
var Promise         = require('ember-cli/lib/ext/promise');
var fs              = require('fs');
var readFile        = Promise.denodeify(fs.readFile);
var mime            = require('mime-types');
var joinUriSegments = require('./util/join-uri-segments');

function headObject(client, params) {
  return new Promise(function(resolve, reject) {
    client.headObject(params, function(err, data) {
      if (err && err.code === 'NotFound') {
        return resolve();
      }
      else if (err) {
        return reject(err);
      }
      else {
        return resolve(data);
      }
    });
  });
}

module.exports = CoreObject.extend({
  init: function(options) {
    var plugin = options.plugin;
    var config = plugin.pluginConfig;

    this._plugin = plugin;
    this._client = plugin.readConfig('s3Client') || new AWS.S3(config);
  },

  upload: function(options) {
    var client                = this._client;
    var plugin                = this._plugin;
    var bucket                = options.bucket;
    var acl                   = options.acl;
    var cacheControl          = options.cacheControl;
    var allowOverwrite        = options.allowOverwrite;
    var key                   = options.filePattern + ":" + options.revisionKey;
    var revisionKey           = joinUriSegments(options.prefix, key);
    var putObject             = Promise.denodeify(client.putObject.bind(client));
    var gzippedFilePaths      = options.gzippedFilePaths || [];
    var isGzipped             = gzippedFilePaths.indexOf(options.filePattern) !== -1;
    var serverSideEncryption  = options.serverSideEncryption;

    var params = {
      Bucket: bucket,
      Key: revisionKey,
      ACL: acl,
      ContentType: mime.lookup(options.filePath) || 'text/html',
      CacheControl: cacheControl
    };

    if (serverSideEncryption) {
      params.ServerSideEncryption = serverSideEncryption;
    }

    if (isGzipped) {
      params.ContentEncoding = 'gzip';
    }

    return this.fetchRevisions(options)
      .then(function(revisions) {
        var found = revisions.map(function(element) { return element.revision; }).indexOf(options.revisionKey);
        if (found >= 0 && !allowOverwrite) {
          return Promise.reject("REVISION ALREADY UPLOADED! (set `allowOverwrite: true` if you want to support overwriting revisions)");
        }
        return Promise.resolve();
      })
      .then(readFile.bind(this, options.filePath))
      .then(function(fileContents) {
        params.Body = fileContents;
        return putObject(params).then(function() {
          plugin.log('✔  ' + revisionKey, { verbose: true });
        });
    });
  },

  activate: function(options) {
    var plugin                = this._plugin;
    var client                = this._client;
    var bucket                = options.bucket;
    var acl                   = options.acl;
    var prefix                = options.prefix;
    var filePattern           = options.filePattern;
    var key                   = filePattern + ":" + options.revisionKey;
    var serverSideEncryption  =  options.serverSideEncryption;

    var revisionKey           = joinUriSegments(prefix, key);
    var indexKey              = joinUriSegments(prefix, filePattern);
    var copySource            = encodeURIComponent([bucket, revisionKey].join('/'));
    var copyObject            = Promise.denodeify(client.copyObject.bind(client));

    var params = {
      Bucket: bucket,
      CopySource: copySource,
      Key: indexKey,
      ACL: acl,
    };

    if (serverSideEncryption) {
      params.ServerSideEncryption = serverSideEncryption;
    }

    return this.fetchRevisions(options).then(function(revisions) {
      var found = revisions.map(function(element) { return element.revision; }).indexOf(options.revisionKey);
      if (found >= 0) {
        return copyObject(params).then(function() {
          plugin.log('✔  ' + revisionKey + " => " + indexKey);
        });
      } else {
        return Promise.reject("REVISION NOT FOUND!"); // see how we should handle a pipeline failure
      }
    });
  },

  fetchRevisions: function(options) {
    var client         = this._client;
    var bucket         = options.bucket;
    var prefix         = options.prefix;
    var revisionPrefix = joinUriSegments(prefix, options.filePattern + ":");
    var indexKey       = joinUriSegments(prefix, options.filePattern);

    return Promise.hash({
      revisions: this.listAllObjects({ Bucket: bucket, Prefix: revisionPrefix }),
      current: headObject(client, { Bucket: bucket, Key: indexKey }),
    })
    .then(function(data) {
      return data.revisions.All.sort(function(a, b) {
        return new Date(b.LastModified) - new Date(a.LastModified);
      }).map(function(d) {
        var revision = d.Key.substr(revisionPrefix.length);
        var active = data.current && d.ETag === data.current.ETag;
        return { revision: revision, timestamp: d.LastModified, active: active };
      });
    });
  },

  listAllObjects: function(options) {
    var client         = this._client;
    var listObjects    = Promise.denodeify(client.listObjects.bind(client));
    var allRevisions   = [];

    function getNextMarker(response) {
      return response.NextMarker || response.Contents[response.Contents.length - 1].Key;
    }

    function listObjectRecursively(options) {
      return listObjects(options).then(function(response) {
        [].push.apply(allRevisions, response.Contents);

        if (response.IsTruncated) {
          options.Marker = getNextMarker(response);
          return listObjectRecursively(options);
        } else {
          response.All = allRevisions;
          return response;
        }
      });
    }

    return listObjectRecursively(options);

  }
});

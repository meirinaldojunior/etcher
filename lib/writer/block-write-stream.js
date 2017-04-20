/*
 * Copyright 2017 resin.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

const _ = require('lodash')
const stream = require('stream')
const fs = require('fs')
const fsBinding = process.binding('fs')
const FSReqWrap = fsBinding.FSReqWrap
const debug = require('debug')('block-write-stream')

/* eslint-disable no-param-reassign */
/* eslint-disable no-underscore-dangle */
/* eslint-disable no-magic-numbers */

const CHUNK_SIZE = 64 * 1024

/**
 * @summary BlockWriteStream
 * @class
 */
class BlockWriteStream extends stream.Writable {
  /**
   * @summary BlockReadStream constructor
   * @param {Object} [options] - options
   * @param {Number} [options.fd] - file descriptor
   * @param {String} [options.path] - file path
   * @param {String} [options.flags] - file open flags
   * @param {Number} [options.mode] - file mode
   * @param {Boolean} [options.autoClose] - automatically close the stream on end
   * @example
   * new BlockWriteStream(options)
   */
  constructor (options) {
    options = _.assign({}, BlockWriteStream.defaults, options)
    options.objectMode = true

    debug('block-write-stream %j', options)

    super(options)

    this._writableState.highWaterMark = 1

    this.fs = options.fs
    this.fd = options.fd
    this.path = options.path
    this.flags = options.flags
    this.mode = options.mode
    this.autoClose = options.autoClose

    this.position = 0
    this.bytesRead = 0
    this.blocksRead = 0
    this.bytesWritten = 0
    this.blocksWritten = 0

    this.closed = false
    this.destroyed = false

    this.once('finish', function () {
      if (this.autoClose) {
        this.close()
      }
    })

    this._chunks = []
    this._chunksLength = 0
    this._flushing = false
    this._firstBlocks = []

    this.open()
  }

  /**
   * @summary Internal write handler
   * @private
   * @param {Buffer} chunk - chunk buffer
   * @param {String} encoding - chunk encoding
   * @param {Function} next - callback(error, value)
   * @example
   * // Not to be called directly
   */
  _write (chunk, encoding, next) {
    // Wait for file handle to be open
    if (_.isNil(this.fd)) {
      this.once('open', () => {
        this._write(chunk, encoding, next)
      })
      return
    }

    let write = false

    this.blocksRead += 1

    if (_.isNil(chunk.position)) {
      chunk.position = this.position
    }

    if (!this._flushing && (chunk.position < CHUNK_SIZE)) {
      this._firstBlocks.push(chunk)
      this.position = chunk.position + chunk.length
      process.nextTick(next)
      return
    }

    if (!this._chunks.length && (chunk.position !== this.position)) {
      this.position = chunk.position
    }

    if (chunk.position !== this.position) {
      const chunks = this._chunks.slice()
      this._writeBlocks(chunks, next)
      this._chunks = []
      this._chunksLength = 0
      write = true
    }

    this._chunks.push(chunk)
    this._chunksLength += chunk.length

    if (this._chunksLength >= CHUNK_SIZE) {
      const chunks = this._chunks.slice()
      this._writeBlocks(chunks, next)
      this._chunks = []
      this._chunksLength = 0
      write = true
    }

    this.position = chunk.position + chunk.length

    if (!write) {
      process.nextTick(next)
    }
  }

  /**
   * @summary Write one or more chunks to the device at a given position
   * @param {Array<Buffer>} chunks - List of buffers
   * @param {Function} next - callback(error, bytesWritten)
   * @example
   * this._writeBlocks([...], (error, bytesWritten) => {
   *   // ...
   * })
   */
  _writeBlocks (chunks, next) {
    if (!chunks.length) {
      process.nextTick(next)
      return
    }

    const position = _.isNil(chunks[0].position) ? chunks[0].position : this.position

    BlockWriteStream.writeBuffers(
      this.fd, chunks, position, (error, bytesWritten) => {
        this.bytesWritten += bytesWritten
        this.blocksWritten += chunks.length
        next(error)
      }
    )
  }

  /**
   * @summary Flush any remaining blocks to the device
   * @param {Function} done - callback(error)
   * @example
   * this._flush(done)
   */
  _flush (done) {
    this._flushing = true
    if (this._chunks.length) {
      this._writeBlocks(this._chunks, (error) => {
        if (error) {
          done(error)
          return
        }
        this._flushFirstBlocks(done)
      })
    } else {
      this._flushFirstBlocks(done)
    }
  }

  /**
   * @summary Flush the first blocks to the device
   * @param {Function} done - callback(error)
   * @example
   * this._flushFirstBlocks(done)
   */
  _flushFirstBlocks (done) {
    this.position = this._firstBlocks[0].position || 0
    this._writeBlocks(this._firstBlocks, (error) => {
      if (error) {
        done(error)
        return
      }

      // We're done here, continue with ending the stream
      // NOTE: Can't use `super()` here, as we're in a function
      Reflect.apply(stream.Writable.prototype.end, this, [ done ])
    })
  }

  /**
   * @summary Open a handle to the file
   * @private
   * @example
   * this.open()
   */
  open () {
    debug('open')

    if (!_.isNil(this.fd)) {
      this.emit('open', this.fd)
      return
    }

    this.fs.open(this.path, this.flags, this.mode, (error, fd) => {
      if (error) {
        if (this.autoClose) {
          this.destroy()
        }
        this.emit('error', error)
      } else {
        this.fd = fd
        this.emit('open', fd)
      }
    })
  }

  /**
   * @summary End the stream
   * @param {Buffer} [chunk] - chunk buffer
   * @param {String} [encoding] - chunk encoding
   * @param {Function} [done] - callback(error, bytesWritten, buffer)
   * @example
   * blockStream.end(buffer)
   */
  end (chunk, encoding, done) {
    if (_.isNil(chunk)) {
      this._flush(done)
    } else {
      this.write(chunk, encoding, (error, bytesWritten) => {
        if (error) {
          this.destroy(error)
          return
        }
        this._flush(done)
      })
    }
  }

  /**
   * @summary Close the underlying resource
   * @param {Function} callback - callback(error)
   * @example
   * blockStream.close((error) => {
   *   // ...
   * })
   */
  close (callback) {
    debug('close')

    if (callback) {
      this.once('close', callback)
    }

    if (this.closed || _.isNil(this.fd)) {
      if (_.isNil(this.fd)) {
        this.once('open', () => {
          this.close()
        })
      } else {
        process.nextTick(() => {
          this.emit('close')
        })
      }
      return
    }

    this.closed = true

    this.fs.close(this.fd, (error) => {
      if (error) {
        this.emit('error', error)
      } else {
        this.emit('close')
      }
    })

    this.fd = null
  }

  /**
   * @summary Destroy the stream, closing
   * the underlying resource in the process
   * @param {Error} [error] - An optional error to emit
   * @example
   * blockStream.destroy()
   */
  destroy (error) {
    debug('destroy')

    // TODO(jhermsmeier): Maybe move below destroyed bailout;
    // check core streams docs for behavior
    if (error) {
      this.emit('error', error)
    }
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    if (this.autoClose) {
      this.close()
    }
  }
}

/**
 * @summary Default options
 * @type {Object}
 * @constant
 */
BlockWriteStream.defaults = {
  fs,
  fd: null,
  path: null,
  flags: 'w',
  mode: 0o666,
  autoClose: true
}

/**
 * @summary Write out multiple buffers at once
 * @private
 * @param {Number} fd - file descriptor
 * @param {Array<Buffer>} chunks - list of buffers
 * @param {Number} position - position
 * @param {Function} callback - callback(error, bytesWritten)
 * @example
 * BlockWriteStream.writeBuffers(fd, chunks, position, (error, bytesWritten) => {
 *   // ...
 * })
 */
BlockWriteStream.writeBuffers = function (fd, chunks, position, callback) {
  const req = new FSReqWrap()

  req.oncomplete = function (error, bytesWritten) {
    callback(error, bytesWritten || 0, chunks)
  }

  fsBinding.writeBuffers(fd, chunks, position, req)
}

module.exports = BlockWriteStream

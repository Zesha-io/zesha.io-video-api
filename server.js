const express = require("express");
const cors = require("cors");

const app = express();
const staticFFMPEG = require("ffmpeg-static");
const { path: staticFfmprobe } = require("ffprobe-static");

const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const multer = require("multer");
const upload = multer({ dest: "tmp/" });
// const storageEngine = multer.diskStorage({
//     destination: "./public",
//     filename: (req, file, cb) => {
//         cb(null, `thumbnail-${uuidv4()}.jpg`);
//     },
// });

const uuidv4 = require("uuid").v4;
const slugify = require("slugify");
const fs = require("fs");
const fetch = require("node-fetch-commonjs");
const extractFrames = require("ffmpeg-extract-frames");
const ffmpeg = require("fluent-ffmpeg");

require("dotenv").config();

const port = process.env.PORT || 8090;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

ffmpeg.setFfmpegPath(staticFFMPEG);
ffmpeg.setFfprobePath(staticFfmprobe);

// const corsOptions = {
//     origin: process.env.ZESHA_WEB_URL,
//     optionsSuccessStatus: 200,
// };

// app.use(cors(corsOptions));

// var allowlist = ["http://localhost:3000"];
// var corsOptionsDelegate = function (req, callback) {
//     var corsOptions;
//     if (allowlist.indexOf(req.header("Origin")) !== -1) {
//         corsOptions = { origin: true }; // reflect (enable) the requested origin in the CORS response
//     } else {
//         corsOptions = { origin: false }; // disable CORS for this request
//     }
//     callback(null, corsOptions); // callback expects two parameters: error and options
// };

app.all("*", function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    next();
});

const s3Client = new S3Client({
    forcePathStyle: false,
    endpoint: "https://nyc3.digitaloceanspaces.com",
    region: "us-east-1",
    credentials: {
        accessKeyId: process.env.DO_SPACES_KEY,
        secretAccessKey: process.env.DO_SPACES_SECRET,
    },
});

const type = upload.single("video");

app.get("/api/healthz", type, async (req, res) => {
    res.status(200).json({ status: "ok" });
});

app.post("/api/space-upload", type, async (req, res) => {
    const { namespace } = req.body;

    const video = req.file;
    if (!video) {
        return response.status(400).json({
            error: "No video file found",
        });
    }

    const key = `${namespace}/${uuidv4()}-${slugify(video.originalname)}`;
    const params = {
        Bucket: process.env.DO_SPACES_BUCKET,
        Key: key,
        Body: fs.createReadStream(video.path),
        ACL: "public-read",
    };

    try {
        const data = await s3Client.send(new PutObjectCommand(params));

        return res.status(200).json({ key });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Error uploading video " });
    }
});

app.post("/api/generate-signed-url", async (req, res) => {
    const { key, namespace } = req.body;

    const bucketParams = {
        Bucket: process.env.DO_SPACES_BUCKET,
        Key: key,
    };

    try {
        const url = await getSignedUrl(
            s3Client,
            new GetObjectCommand(bucketParams),
            { expiresIn: 48 * 60 * 60 }
        ); // 1hr expiration.

        return res.status(200).json({ url });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Error generating presigned url" });
    }
});

//@Todo: Clean up tmp files
//Thumbnail & Length
app.post("/api/get-video-metadata", async (req, res) => {
    const { url } = req.body;

    const name = `thumbnail-${uuidv4()}.jpg`;
    const thumbnail = `./public/${name}`;

    try {
        await extractFrames({
            input: url,
            output: thumbnail,
            offsets: [3500],
        });

        ffmpeg(url).ffprobe(function (err, metadata) {
            if (err) {
                console.log(err);
                return res
                    .status(500)
                    .json({ error: "Error generating metadata" });
            }

            const { duration, size, tags, format_name } = metadata.format;

            return res
                .status(200)
                .json({ thumbnail: name, duration, size, tags, format_name });
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Error generating metadata" });
    }
});

app.post("/api/upload-video-to-theta", async (req, res) => {
    console.log(req.body);
    const { url, nft_collection } = req.body;

    try {
        const result = await fetch("https://api.thetavideoapi.com/video", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-tva-sa-id": process.env.THETA_API_KEY,
                "x-tva-sa-secret": process.env.THETA_API_SECRET,
            },
            body: JSON.stringify({
                source_uri: url,
                playback_policy: "public",
                nft_collection: nft_collection,
            }),
        });

        const data = await result.json();

        if (!result.ok) {
            console.log(data);

            return res.status(500).json({ error: data.error });
        }

        return res.status(200).json({ video_id: data.body?.videos[0]?.id });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Error encoding video" });
    }
});

app.get("/api/video-transcoding-status", async (req, res) => {
    const { video_id } = req.query;

    try {
        const result = await fetch(
            `https://api.thetavideoapi.com/video/${video_id}`,
            {
                method: "GET",
                headers: {
                    "x-tva-sa-id": process.env.THETA_API_KEY,
                    "x-tva-sa-secret": process.env.THETA_API_SECRET,
                },
            }
        );

        const data = await result.json();

        if (!result.ok) {
            console.log(data.error);

            return res.status(500).json({ error: data.error });
        }

        return res.status(200).json({
            video_id: data.body?.videos[0]?.id,
            state: data.body?.videos[0]?.state,
            progress: data.body?.videos[0]?.progress,
        });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Cannot get video encoding status" });
    }
});

app.post(
    "/api/upload-thumbnail",
    upload.single("thumbnail"),
    async (req, res) => {
        const thumbnail = req.file;
        if (!thumbnail) {
            return response.status(400).json({
                error: "No thumbnail file found",
            });
        }

        const name = `thumbnail-${uuidv4()}.jpg`;
        const thumbnailPath = `./public/${name}`;

        try {
            console.log(thumbnail.path);
            fs.copyFile(thumbnail.path, thumbnailPath, (err) => {
                if (err) {
                    console.log(err);
                    return res
                        .status(500)
                        .json({ error: "Error uploading thumbnail" });
                } else {
                    return res.status(200).json({ name });
                }
            });
        } catch (error) {
            console.log(error);
            res.status(500).json({ error: "Error uploading video " });
        }
    }
);

app.listen(port, () => {
    console.log(`Zesha video api listening on port ${port}`);
});

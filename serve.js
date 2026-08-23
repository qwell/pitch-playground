import express from 'express';

const app = express();
const port = 3000;

app.use((req, res, next) => {
    const started = Date.now();

    console.log(`--> ${req.method} ${req.url}`);

    res.on('finish', () => {
        console.log(
            `<-- ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`
        );
    });

    res.on('close', () => {
        if (!res.writableFinished) {
            console.warn(
                `xxx ${req.method} ${req.url} connection closed early`
            );
        }
    });

    next();
});

app.use(express.static('./site'));

app.use((req, res) => {
    console.warn(`404 ${req.method} ${req.url}`);
    res.status(404).send('Not found');
});

app.use((err, req, res) => {
    console.error(err);
    res.status(500).send('Internal server error');
});

app.listen(port, () => {
    console.log(`Serving ./site at http://localhost:${port}`);
});

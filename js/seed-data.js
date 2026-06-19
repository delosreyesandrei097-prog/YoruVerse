/**
 * ============================================================
 * MANHWA PLATFORM - SEED DATA SCRIPT
 * ============================================================
 * Run this in the browser console after setting up Firebase
 * to populate sample data for testing.
 * 
 * Instructions:
 * 1. Login as admin
 * 2. Open browser console (F12)
 * 3. Paste and run: await seedSampleData()
 * ============================================================
 */

async function seedSampleData() {
  if (!auth.currentUser) {
    console.error('Please login first');
    return;
  }

  const userDoc = await db.collection('users').doc(auth.currentUser.uid).get();
  if (!userDoc.exists || (userDoc.data().role !== 'admin' && userDoc.data().role !== 'moderator')) {
    console.error('Admin access required');
    return;
  }

  console.log('Seeding sample data...');

  const sampleSeries = [
    {
      title: "Solo Leveling",
      alternativeTitles: ["Only I Level Up", "Na Honjaman Level Up"],
      coverImage: "https://upload.wikimedia.org/wikipedia/en/thumb/6/6c/Solo_Leveling_Webtoon.png/220px-Solo_Leveling_Webtoon.png",
      author: "Chugong",
      artist: "DUBU",
      genres: ["Action", "Fantasy", "Supernatural"],
      status: "Completed",
      releaseYear: 2018,
      synopsis: "In a world where hunters — humans who possess magical abilities — must battle deadly monsters to protect mankind, Sung Jin-Woo is known as the Weakest Hunter of All Mankind. But after a mysterious event in a deadly dungeon, he gains the ability to level up and become the strongest hunter.",
      rating: 4.9,
      ratingCount: 12500,
      viewCount: 500000,
      followCount: 85000
    },
    {
      title: "Tower of God",
      alternativeTitles: ["Sin-ui Tap"],
      coverImage: "https://upload.wikimedia.org/wikipedia/en/thumb/1/19/Tower_of_God_Webtoon.png/220px-Tower_of_God_Webtoon.png",
      author: "SIU",
      artist: "SIU",
      genres: ["Action", "Fantasy", "Drama"],
      status: "Ongoing",
      releaseYear: 2010,
      synopsis: "Twenty-Fifth Bam has spent most of his life trapped beneath a mysterious Tower, with only his friend Rachel for company. When Rachel enters the Tower, Bam follows her, facing deadly challenges on each floor to find her.",
      rating: 4.7,
      ratingCount: 9800,
      viewCount: 420000,
      followCount: 72000
    },
    {
      title: "True Beauty",
      alternativeTitles: ["Descent of a Goddess"],
      coverImage: "https://upload.wikimedia.org/wikipedia/en/thumb/6/64/True_Beauty_Webtoon.png/220px-True_Beauty_Webtoon.png",
      author: "Yaongyi",
      artist: "Yaongyi",
      genres: ["Romance", "Comedy", "Drama"],
      status: "Completed",
      releaseYear: 2018,
      synopsis: "After being bullied for her appearance, Jugyeong masters the art of makeup transformation. Now beautiful at school but plain at home, she must navigate love triangles while keeping her double life secret.",
      rating: 4.5,
      ratingCount: 8700,
      viewCount: 380000,
      followCount: 65000
    },
    {
      title: "Lore Olympus",
      alternativeTitles: [],
      coverImage: "https://upload.wikimedia.org/wikipedia/en/thumb/c/cf/Lore_Olympus_Webtoon.png/220px-Lore_Olympus_Webtoon.png",
      author: "Rachel Smythe",
      artist: "Rachel Smythe",
      genres: ["Romance", "Fantasy", "Drama"],
      status: "Completed",
      releaseYear: 2018,
      synopsis: "A modern retelling of the abduction of Persephone. Witness a story of love, heartbreak, and personal growth set in a beautifully reimagined Greek mythology.",
      rating: 4.8,
      ratingCount: 7200,
      viewCount: 310000,
      followCount: 54000
    },
    {
      title: "Omniscient Reader",
      alternativeTitles: ["Omniscient Reader's Viewpoint", "Jeonjijeok Dokja Sijeom"],
      coverImage: "https://upload.wikimedia.org/wikipedia/en/thumb/a/a7/Omniscient_Reader_Webtoon.png/220px-Omniscient_Reader_Webtoon.png",
      author: "Sing-Shong",
      artist: "Sleepy-C",
      genres: ["Action", "Fantasy", "Supernatural"],
      status: "Ongoing",
      releaseYear: 2020,
      synopsis: "Kim Dokja is the sole reader of a web novel that has been ongoing for 10 years. When the novel suddenly becomes reality, he's the only one who knows how the story ends and uses this knowledge to survive.",
      rating: 4.8,
      ratingCount: 10200,
      viewCount: 450000,
      followCount: 78000
    },
    {
      title: "Lookism",
      alternativeTitles: [],
      coverImage: "https://upload.wikimedia.org/wikipedia/en/thumb/9/9e/Lookism_Webtoon.png/220px-Lookism_Webtoon.png",
      author: "Taejoon Park",
      artist: "Taejoon Park",
      genres: ["Drama", "Slice of Life"],
      status: "Ongoing",
      releaseYear: 2014,
      synopsis: "Daniel is an unattractive loner who wakes up one day in a different, handsome body. Now navigating life with two bodies, he discovers how differently people treat him based on appearances.",
      rating: 4.6,
      ratingCount: 6800,
      viewCount: 290000,
      followCount: 48000
    },
    {
      title: "Noblesse",
      alternativeTitles: [],
      coverImage: "https://upload.wikimedia.org/wikipedia/en/thumb/9/9c/Noblesse_Webtoon.png/220px-Noblesse_Webtoon.png",
      author: "Son Jeho",
      artist: "Lee Kwangsu",
      genres: ["Action", "Supernatural", "Fantasy"],
      status: "Completed",
      releaseYear: 2007,
      synopsis: "Rai, a powerful noble, wakes up after 820 years of slumber and starts attending high school. He must protect his new human friends from the Union, a secret organization that threatens both humans and nobles.",
      rating: 4.7,
      ratingCount: 8900,
      viewCount: 360000,
      followCount: 61000
    },
    {
      title: "Sweet Home",
      alternativeTitles: [],
      coverImage: "https://upload.wikimedia.org/wikipedia/en/thumb/7/74/Sweet_Home_Webtoon.png/220px-Sweet_Home_Webtoon.png",
      author: "Carnby Kim",
      artist: "Youngchan Hwang",
      genres: ["Horror", "Thriller", "Supernatural"],
      status: "Completed",
      releaseYear: 2017,
      synopsis: "After losing his family in an accident, Cha Hyun-su moves into a new apartment. When people start turning into monsters reflecting their deepest desires, he must fight to survive and protect his neighbors.",
      rating: 4.6,
      ratingCount: 7600,
      viewCount: 320000,
      followCount: 52000
    }
  ];

  // Add series
  const seriesRefs = [];
  for (const seriesData of sampleSeries) {
    const docRef = await db.collection('series').add({
      ...seriesData,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    seriesRefs.push({ id: docRef.id, ...seriesData });
    console.log(`Added series: ${seriesData.title}`);
  }

  // Add sample chapters for each series
  for (const series of seriesRefs) {
    const numChapters = Math.floor(Math.random() * 20) + 5; // 5-25 chapters
    
    for (let i = 1; i <= numChapters; i++) {
      const imageUrls = [];
      const numPages = Math.floor(Math.random() * 15) + 5; // 5-20 pages
      
      for (let p = 1; p <= numPages; p++) {
        // Use placeholder images for demo
        imageUrls.push(`https://via.placeholder.com/800x1200/1a1a24/3a3a4d?text=Ch.${i}+Page+${p}`);
      }

      await db.collection('chapters').add({
        seriesId: series.id,
        chapterNumber: i,
        chapterTitle: i === 1 ? 'Prologue' : `Chapter ${i}`,
        chapterUrl: '',
        imageUrls: imageUrls,
        source: 'seed_data',
        releaseDate: new Date(Date.now() - (numChapters - i) * 7 * 24 * 60 * 60 * 1000).toISOString(),
        viewCount: Math.floor(Math.random() * 5000),
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }

    // Update series with latest chapter
    await db.collection('series').doc(series.id).update({
      latestChapter: numChapters,
      latestChapterTitle: `Chapter ${numChapters}`
    });

    console.log(`Added ${numChapters} chapters for: ${series.title}`);
  }

  // Add sample comments
  const sampleComments = [
    "Amazing chapter! Can't wait for the next one!",
    "The art is getting better and better.",
    "This plot twist was unexpected!",
    "Love the character development here.",
    "The action scenes are so well drawn.",
    "I'm hooked on this series now.",
    "Best manhwa I've read this year!",
    "The pacing is perfect.",
    "Need more chapters like this!",
    "The cliffhanger is killing me!"
  ];

  // Get first chapter from first series for sample comments
  if (seriesRefs.length > 0) {
    const firstSeries = seriesRefs[0];
    const chaptersSnapshot = await db.collection('chapters')
      .where('seriesId', '==', firstSeries.id)
      .limit(1)
      .get();

    if (!chaptersSnapshot.empty) {
      const chapterId = chaptersSnapshot.docs[0].id;

      for (let i = 0; i < 8; i++) {
        await db.collection('comments').add({
          chapterId: chapterId,
          userId: 'sample_user_' + i,
          username: ['Reader1', 'MangaFan', 'WebtoonLover', 'Otaku99', 'ManhwaKing', 'ChapterHunter', 'ArtLover', 'StoryFan'][i],
          avatar: '/images/default-avatar.png',
          content: sampleComments[i],
          likes: Math.floor(Math.random() * 50),
          likedBy: [],
          parentCommentId: null,
          createdAt: firebase.firestore.Timestamp.fromDate(new Date(Date.now() - i * 3600000)),
          updatedAt: firebase.firestore.Timestamp.fromDate(new Date(Date.now() - i * 3600000))
        });
      }
      console.log('Added sample comments');
    }
  }

  // Add genres
  const genres = [
    { name: 'Action', slug: 'action' },
    { name: 'Adventure', slug: 'adventure' },
    { name: 'Comedy', slug: 'comedy' },
    { name: 'Crazy MC', slug: 'crazy-mc' },
    { name: 'Demon', slug: 'demon' },
    { name: 'Drama', slug: 'drama' },
    { name: 'Dungeons', slug: 'dungeons' },
    { name: 'Fantasy', slug: 'fantasy' },
    { name: 'Game', slug: 'game' },
    { name: 'Genius MC', slug: 'genius-mc' },
    { name: 'Isekai', slug: 'isekai' },
    { name: 'Kuchikuchi', slug: 'kuchikuchi' },
    { name: 'Magic', slug: 'magic' },
    { name: 'Martial Arts', slug: 'martial-arts' },
    { name: 'Murim', slug: 'murim' },
    { name: 'Mystery', slug: 'mystery' },
    { name: 'Necromancer', slug: 'necromancer' },
    { name: 'Overpowered', slug: 'overpowered' },
    { name: 'Regression', slug: 'regression' },
    { name: 'Reincarnation', slug: 'reincarnation' },
    { name: 'Revenge', slug: 'revenge' },
    { name: 'Romance', slug: 'romance' },
    { name: 'School Life', slug: 'school-life' },
    { name: 'Sci-Fi', slug: 'sci-fi' },
    { name: 'Shoujo', slug: 'shoujo' },
    { name: 'Shounen', slug: 'shounen' },
    { name: 'System', slug: 'system' },
    { name: 'Tower', slug: 'tower' },
    { name: 'Tragedy', slug: 'tragedy' },
    { name: 'Villain', slug: 'villain' },
    { name: 'Violence', slug: 'violence' },
    { name: 'Manhwa', slug: 'manhwa' },
    { name: 'Manga', slug: 'manga' }
  ];

  for (const genre of genres) {
    await db.collection('genres').doc(genre.slug).set(genre);
  }
  console.log('Added genres');

  console.log('✅ Seed data complete!');
  console.log(`Added ${sampleSeries.length} series with chapters`);
}

// Expose to window
window.seedSampleData = seedSampleData;
